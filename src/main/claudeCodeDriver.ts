import { tm } from './lang'
import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { CH } from '@shared/ipc'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentQuestionAnswer,
  AgentRewind,
  AiContentPart,
  AiMessage,
  ClaudeCliQuestion,
  ClaudePermissionDecision,
  ClaudeSessionInfo,
  ClaudeStartOpts,
  ClaudeStreamEvent,
  SkillLayer,
  SkillState
} from '@shared/types'
import { rewindPoint } from '@shared/rewind'
import { asSkillState, withSkillOverride } from '@shared/skills'
import { readSettingsFile, readSkillOverrides, skillSettingsPaths } from './skillSettings'
// Та же атомарная запись, что у собственных настроек: правка чужого конфига —
// тем более не то место, где допустим полуписаный файл после падения.
import { writeJsonAtomic } from './jsonStore'
import type { AgentDriver } from './agentDriver'
import { bundledPkgName, claudeExeName, resolveClaudeExe, type ExePick } from './claudeExe'
// Types only (erased at runtime) — safe to import statically from the ESM-only
// package; the runtime value is loaded via a dynamic import below.
import { cleanCommands } from '@shared/agentCommands'
import { isNoticeSubtype, noticeFor } from './systemNotices'
import { endReasonText } from './turnOutcome'
import { isEditTool } from '@shared/editTools'

/** Число из сообщения движка, если оно там есть и осмысленно. */
function numOr(msg: unknown, key: string): number | undefined {
  const v = (msg as Record<string, unknown>)?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}
import { irreversible } from '@shared/irreversible'
import { taskDone, taskHidden, taskOutcome } from '@shared/agentTasks'
import { foldContextParts } from '@shared/contextParts'
import {
  foldMcpTokens,
  markIndex,
  mcpRowFrom,
  skillsFrom,
  sortMcpRows,
  type RawMcpStatus,
  type RawMcpTool
} from '@shared/mcp'
import type { McpSnapshot } from '@shared/types'
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'

/**
 * Load the ESM-only Agent SDK from CommonJS main. A static `import` would be
 * downleveled to `require()` by electron-vite's CJS output and throw
 * ERR_REQUIRE_ESM; `new Function` keeps a genuine dynamic `import()` that
 * rollup won't rewrite.
 */
const loadSdk = new Function('m', 'return import(m)') as (
  m: string
) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>

/**
 * Path to the binary Zarya ships. When packaged, the SDK would resolve it to a
 * path INSIDE app.asar (which the OS can't exec — "exists but failed to
 * launch"); it is asar-unpacked, so point at the real on-disk copy. In dev it
 * sits in node_modules.
 */
function bundledClaudePath(): string | undefined {
  const pkg = bundledPkgName(process.platform, process.arch)
  const exe = claudeExeName(process.platform)
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')]
    : [join(app.getAppPath(), 'node_modules'), join(process.cwd(), 'node_modules')]
  for (const root of roots) {
    const p = join(root, '@anthropic-ai', pkg, exe)
    if (existsSync(p)) return p
  }
  return undefined
}

/**
 * How long a binary choice is trusted before we re-probe. The chosen PATH is
 * stable across CLI self-updates (the file is replaced in place), so this only
 * matters for the rarer flip — the user's CLI overtaking the bundled one while
 * Zarya is open. Re-checking costs two `--version` spawns at most twice an
 * hour, and only when a session starts or the launch console is opened.
 */
const EXE_RECHECK_MS = 30 * 60_000

/** Hard deadline for a session-less control request (catalog / usage probe). */
const IDLE_QUERY_TIMEOUT_MS = 20_000

/**
 * How long a freshly fetched model catalog is reused. Long enough that opening
 * and closing the launch console repeatedly costs one CLI spawn, short enough
 * that a model released (or a CLI updated) mid-session shows up on its own.
 */
const MODELS_CACHE_MS = 5 * 60_000

/**
 * Which `claude` to run. Prefers the user's own (self-updating) CLI when it is
 * strictly newer on the same major, so newly released models show up without
 * rebuilding Zarya — see claudeExe.ts for the policy. Cached with a TTL so a
 * mid-session CLI update is picked up without restarting the app.
 */
let claudeExePromise: Promise<ExePick> | undefined
let claudeExeAt = 0
function claudeExe(): Promise<ExePick> {
  const now = Date.now()
  if (!claudeExePromise || now - claudeExeAt > EXE_RECHECK_MS) {
    claudeExeAt = now
    const pending = resolveClaudeExe({
      bundledPath: bundledClaudePath(),
      platform: process.platform,
      env: process.env,
      home: homedir()
    }).then((pick) => {
      if (process.env.ZARYA_DEBUG) {
        console.error('[claude-code] binary:', pick.reason, pick.path ?? '(sdk default)')
      }
      return pick
    })
    // Keep serving the previous answer if a re-probe fails, so a transient
    // spawn hiccup can never downgrade a working choice to 'sdk-default'.
    const prev = claudeExePromise
    claudeExePromise = prev ? pending.catch(() => prev) : pending
  }
  return claudeExePromise
}

/** An async message queue feeding query()'s streaming-input iterable. */
function createInputQueue(): {
  push: (m: SDKUserMessage) => boolean
  close: () => void
  isClosed: () => boolean
  iterable: AsyncIterable<SDKUserMessage>
} {
  const buffer: SDKUserMessage[] = []
  let pending: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  let closed = false
  return {
    /**
     * Returns false when the queue is already closed — nobody will ever read it
     * again. Silently buffering into a dead queue lost the user's message: the
     * UI had already switched to «working», the prompt went nowhere, and the
     * only visible trace was an unrelated «process exited» banner.
     */
    push(m) {
      if (closed) return false
      if (pending) {
        pending({ value: m, done: false })
        pending = null
      } else buffer.push(m)
      return true
    },
    isClosed: () => closed,
    close() {
      closed = true
      if (pending) {
        pending({ value: undefined as unknown as SDKUserMessage, done: true })
        pending = null
      }
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (buffer.length) {
            yield buffer.shift() as SDKUserMessage
            continue
          }
          if (closed) return
          const r = await new Promise<IteratorResult<SDKUserMessage>>((res) => (pending = res))
          if (r.done) return
          yield r.value
        }
      }
    }
  }
}

/**
 * Сообщение пользователя для SDK. Без картинок — строкой, как было: менять
 * форму там, где она не нужна, значит трогать путь, который работает.
 *
 * С картинками — массивом блоков: текст первым, изображения следом и в том же
 * порядке, в каком их вставил человек. Плейсхолдеры «[Изображение #N]» уже стоят
 * в тексте (их ставит рендерер), поэтому модель видит, к чему относится каждая.
 */
function userMessage(text: string, images?: ClaudeStartOpts['images']): SDKUserMessage {
  const content = images?.length
    ? [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data }
        }))
      ]
    : text
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null
  } as unknown as SDKUserMessage
}

/** Map an Anthropic content-block array (from a message) to our AiContentPart[]. */
function mapAssistantContent(content: unknown): AiContentPart[] {
  if (!Array.isArray(content)) return []
  const out: AiContentPart[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        input: block.input ?? {}
      })
    }
    else if (
      (block.type === 'thinking' || block.type === 'redacted_thinking') &&
      typeof block.thinking === 'string' &&
      block.thinking.trim()
    ) {
      /*
       * Рассуждение модели. Раньше блок молча выбрасывался, и человек видел
       * только вывод: почему агент выбрал этот путь, узнать было негде — а
       * именно это чаще всего и надо, когда он выбрал НЕ ТОТ путь.
       *
       * Зашифрованное рассуждение (`redacted_thinking`) приходит без текста и
       * сюда не попадает: показывать нечего, а пустая шторка «рассуждение»
       * обещала бы содержимое, которого нет.
       */
      out.push({ type: 'thinking', text: block.thinking })
    }
  }
  return out
}

/** Map a persisted SessionMessage (from getSessionMessages) to our AiMessage. */
function sessionMsgToAiMessage(sm: Record<string, unknown>): AiMessage | null {
  const role = sm.type === 'assistant' ? 'assistant' : sm.type === 'user' ? 'user' : null
  if (!role) return null
  const content = (sm.message as { content?: unknown })?.content
  if (role === 'assistant') {
    const parts = mapAssistantContent(content)
    return parts.length ? { role, content: parts } : null
  }
  const parts: AiContentPart[] = []
  if (typeof content === 'string') {
    if (content.trim() && !content.startsWith('[Контекст:'))
      parts.push({ type: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        parts.push({ type: 'text', text: b.text })
      } else if (b.type === 'tool_result') {
        parts.push({
          type: 'tool_result',
          toolUseId: String(b.tool_use_id ?? ''),
          content: toolResultText(b.content),
          isError: !!b.is_error
        })
      }
    }
  }
  return parts.length ? { role, content: parts } : null
}

/** Flatten a tool_result content (string | array of blocks) to display text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: Record<string, unknown>) =>
        b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Read the reasoning effort from the user's global Claude config, if present. */
/** Permission modes the driver will forward — never 'bypassPermissions'/'dontAsk'. */
const SAFE_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan'])

/**
 * Как часто отдавать накопленный текст ответа, мс.
 *
 * 50 мс — ровно печать на глаз (20 обновлений в секунду) и предел, за которым
 * лента начинает перерисовываться чаще, чем экран успевает показать.
 */
const DELTA_MS = 50

function readClaudeEffort(): string | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    const cfg = JSON.parse(raw) as { effortLevel?: string }
    return typeof cfg.effortLevel === 'string' ? cfg.effortLevel : undefined
  } catch {
    return undefined
  }
}

/** Normalize the SDK's /usage response into our ClaudeUsage shape. */
function usageFromResponse(resp: unknown): import('@shared/types').ClaudeUsage {
  const r = resp as {
    subscription_type?: string
    rate_limits?: {
      five_hour?: { utilization?: number | null; resets_at?: string | null } | null
      seven_day?: { utilization?: number | null; resets_at?: string | null } | null
    } | null
  }
  const toTs = (s?: string | null): number | undefined => {
    if (!s) return undefined
    const t = Date.parse(s)
    return Number.isNaN(t) ? undefined : t
  }
  return {
    subscriptionType: r.subscription_type ?? undefined,
    fiveHourPct: r.rate_limits?.five_hour?.utilization ?? undefined,
    fiveHourResetsAt: toTs(r.rate_limits?.five_hour?.resets_at),
    sevenDayPct: r.rate_limits?.seven_day?.utilization ?? undefined,
    sevenDayResetsAt: toTs(r.rate_limits?.seven_day?.resets_at)
  }
}

/** Normalize the SDK's supportedModels() rows into our ClaudeModelInfo shape. */
function mapModelList(
  list: Array<Record<string, unknown>>
): import('@shared/types').ClaudeModelInfo[] {
  return list.map((m) => ({
    value: String(m.value ?? ''),
    resolvedModel: typeof m.resolvedModel === 'string' ? m.resolvedModel : undefined,
    displayName: String(m.displayName ?? m.value ?? ''),
    description: typeof m.description === 'string' ? m.description : undefined,
    supportsEffort: typeof m.supportsEffort === 'boolean' ? m.supportsEffort : undefined,
    supportedEffortLevels: Array.isArray(m.supportedEffortLevels)
      ? (m.supportedEffortLevels as import('@shared/types').ClaudeEffortLevel[])
      : undefined
  }))
}

/** Extract the AskUserQuestion prompts from a tool input, if shaped like one. */
function extractQuestions(input: unknown): ClaudeCliQuestion[] | undefined {
  const qs = (input as { questions?: unknown })?.questions
  if (!Array.isArray(qs)) return undefined
  return qs.map((q: Record<string, unknown>) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    multiSelect: !!q.multiSelect,
    options: Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).map((o) => ({
          label: String(o.label ?? ''),
          description: typeof o.description === 'string' ? o.description : undefined,
          preview: typeof o.preview === 'string' ? o.preview : undefined
        }))
      : []
  }))
}

interface Session {
  query: Query
  input: ReturnType<typeof createInputQueue>
  abort: AbortController
  /** Папка, в которой работает эта беседа (нужна наблюдателю за скиллами и MCP). */
  cwd?: string
  /** toolUseID -> resolver for a canUseTool call awaiting the user's decision. */
  perms: Map<string, (r: PermissionResult | null) => void>
  /** toolUseID -> the AskUserQuestion questions, so resolveQuestion rebuilds the answer envelope. */
  pendingQuestions: Map<string, ClaudeCliQuestion[]>
  /** Bypass ('без спроса'): auto-approve ordinary tools in canUseTool (live-toggleable). */
  bypass: boolean
  /** «Правки без спроса»: авто-допуск ТОЛЬКО для правок файлов (live-toggleable). */
  editsAuto: boolean
  /** Effort override for this session, so init reports the effective value. */
  effort?: string
  /** Model + ultracode this session is currently running, so a follow-up turn
   *  can tell an actual change from a no-op and re-apply only what moved. */
  model?: string
  ultracode?: boolean
  /** The user pressed Esc: a subsequent process exit is expected, not a failure. */
  interrupted?: boolean
  /** Task ids that are plain shell commands, not subagents — filtered from the count. */
  shellTasks: Set<string>
  /**
   * taskId → род задачи, как назвал его движок при запуске.
   *
   * Помним отдельно, потому что род приходит ОДИН раз, в `task_started`: без
   * этого воркфлоу опознавался бы только в первый миг своей жизни, а во всех
   * последующих событиях выглядел бы безымянной задачей.
   */
  taskKinds: Map<string, string>
  /** Накопленные куски ответа, ещё не отданные на экран. */
  deltaBuf?: string
  /** Таймер отдачи накопленного. */
  deltaTimer?: ReturnType<typeof setTimeout>
  /**
   * UUID последнего ОТВЕТА агента. Точка, с которой можно продолжить беседу, не
   * взяв в контекст то, что было после неё, — см. rewindAfterInterrupt.
   */
  lastAssistantUuid?: string
  /** Id сессии из init — нужен, чтобы продолжить веткой после отмены. */
  claudeSessionId?: string
  /** Сессия продолжает прежнюю историю (`resume`), а не начата с нуля. */
  resumed: boolean
  /**
   * Точка, от которой эта сессия сама была отмотана. Живёт, пока агент в ней
   * ничего не сказал: два Esc подряд отматывают к одному и тому же месту.
   */
  forkBase?: { sessionId: string; at: string }
  /**
   * Человек отменил отправленное сообщение (Esc). В истории этой сессии
   * отменённое уже лежит, поэтому дописывать в неё нельзя: следующий ход её
   * гасит и стартует заново (веткой — по opts.resumeAt от рендерера).
   */
  rewound?: boolean
}

/**
 * Native Claude Code driver: one live headless Agent-SDK session per requestId.
 * The subprocess runs on the machine's own `claude` login (subscription / Max),
 * so no API key is needed. Tool permissions and AskUserQuestion prompts are
 * surfaced to the renderer via `canUseTool` and resolved by a UI click.
 */
export class ClaudeCodeDriver implements AgentDriver {
  readonly engine: AgentEngine = 'claude-code'
  /** Claude Code supports the full control surface (see AgentCapabilities). */
  readonly capabilities: AgentCapabilities = {
    models: true,
    modelsWithoutSession: false, // supportedModels() needs a live session
    effort: true,
    bypass: true,
    resumableSessions: true,
    usage: true,
    structuredQuestions: true,
    // resumeSessionAt + forkSession — см. rewindAfterInterrupt.
    rewind: true,
    // Родной формат SDK: изображение уходит блоком в том же сообщении.
    images: true,
    // mcpServerStatus / reconnectMcpServer / toggleMcpServer + getContextUsage.
    mcp: true,
    // query.stopTask(taskId) — остановить одну задачу, не обрывая ход.
    stopTask: true,
    // permissionMode: 'plan' в опциях запуска + setPermissionMode на ходу.
    planMode: true,
    vendorFlags: [{ key: 'ultracode', label: 'ULTRACODE', desc: tm('drv.ultracode') }]
  }
  private sessions = new Map<string, Session>()
  /**
   * Отложенное «гашу рабочий процесс»: показывается, только если после него не
   * пришло ничего. Возобновлённая беседа приносит такое сообщение из прошлой
   * жизни сессии, и дословный показ объявлял бы обрыв там, где его нет.
   */
  private workerDownTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Последний состав инструментов каждой беседы.
   *
   * Нужен, чтобы после закрытия панели окно показало прошлый снимок с честной
   * пометкой «не свежий», а не пустоту (пустота читается как «серверов нет»).
   * Живёт в памяти и умирает вместе с окном: файл на диске был бы ровно тем
   * мусором, который мы обещали не оставлять. Размер ограничен — беседы за
   * день накапливаются, а снимки нужны только недавним.
   */
  private mcpSnapshots = new Map<string, McpSnapshot>()
  /**
   * Папка беседы — переживает закрытие сессии.
   *
   * Настройки проекта лежат на диске и не исчезают вместе с сессией: без этой
   * карты вкладка «Инструменты» показывала бы переключатель скилла, который
   * перекрыт настройками проекта, — кнопку, которая «сработает» и ничего не
   * изменит. Ограничена по размеру, как и снимки: строки, а не архив.
   */
  private lastCwd = new Map<string, string>()
  /**
   * Чем серверы пометили свои инструменты — по беседам.
   *
   * Пометки нужны карточке одобрения: сервер вправе объявить инструмент
   * разрушающим, и молчать об этом, зная, — значит скрывать от человека то,
   * что у нас уже есть. Спрашиваем один раз на сессию (серверы к тому моменту
   * подняты ею же, так что это дешёвый вопрос, а не проверка связи).
   */
  private mcpMarks = new Map<string, Record<string, import('@shared/mcp').McpMark>>()
  /** Запрос карты в полёте: первый MCP-гейт не должен звать её дважды. */
  private mcpMarksInFlight = new Map<
    string,
    Promise<Record<string, import('@shared/mcp').McpMark> | undefined>
  >()
  private getWindow: () => BrowserWindow | null
  private usageTimer?: ReturnType<typeof setInterval>
  private ambientTimer?: ReturnType<typeof setInterval>
  /**
   * The exact flag payloads last handed to the SDK per session, for QA to verify
   * that model / effort / ultracode / bypass changes actually reach the live
   * query (not just the UI). Never surfaced in normal operation.
   */
  private lastFlags = new Map<string, Record<string, unknown>>()

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow
  }

  private recordFlag(requestId: string, patch: Record<string, unknown>): void {
    const prev = this.lastFlags.get(requestId) ?? {}
    this.lastFlags.set(requestId, { ...prev, ...patch, at: Date.now() })
  }

  /** QA: the last flag payloads applied to a session's live query. */
  debugFlags(requestId?: string): Record<string, unknown> {
    if (requestId) return this.lastFlags.get(requestId) ?? {}
    // No id → merge the most recently-touched session (harness convenience).
    let latest: Record<string, unknown> = {}
    for (const f of this.lastFlags.values()) {
      if (((f.at as number) ?? 0) >= ((latest.at as number) ?? 0)) latest = f
    }
    return latest
  }

  /** Poll the subscription usage every minute while any session is live. */
  private ensureUsagePoll(): void {
    if (this.usageTimer) return
    this.usageTimer = setInterval(() => {
      const entry = this.sessions.entries().next().value
      if (!entry) {
        clearInterval(this.usageTimer)
        this.usageTimer = undefined
        return
      }
      void this.fetchUsage(entry[0], entry[1])
    }, 60_000)
  }

  private emit(requestId: string, ev: ClaudeStreamEvent): void {
    // Отменённая сессия ещё доживает свои события: после interrupt приходит
    // 'result', а CLI шлёт вдогонку повторный 'init' с тем же id. Её id больше
    // не описывает беседу — рендерер уже решил, откуда продолжать. Пропустить их
    // как есть значило бы снять точку отмотки (init) или вернуть забытый id
    // (result), то есть тихо втащить отменённое сообщение обратно в контекст.
    const s = this.sessions.get(requestId)
    if (process.env.ZARYA_DEBUG && (ev.type === 'init' || ev.type === 'result'))
      console.error(
        '[claude-code] ids',
        JSON.stringify({ ev: ev.type, sid: ev.sessionId, rewound: !!s?.rewound })
      )
    if (s?.rewound) {
      if (ev.type === 'init') return
      if (ev.type === 'result') ev = { ...ev, sessionId: undefined }
    }
    // Generic agent stream — carries `engine` so the renderer routes without a
    // per-vendor channel. The claudeCode.* preload shim filters to this engine.
    this.getWindow()?.webContents.send(CH.agentStream, requestId, this.engine, ev)
  }

  async start(requestId: string, opts: ClaudeStartOpts): Promise<void> {
    // A follow-up turn on an existing live session just enqueues the message.
    // Unless that session is on its way out: an interrupt closes the input queue
    // and the process exits asynchronously, so for a moment a dead session is
    // still in the map. Sending into it lost the prompt without a word — drop
    // the entry and fall through to spawning a fresh session instead.
    const existing = this.sessions.get(requestId)
    // Отмена отправленного сообщения: дописывать в ту же сессию нельзя — в её
    // истории отменённое уже лежит. Гасим её; куда продолжать, говорит рендерер
    // (opts.resume + opts.resumeAt), потому что это должно пережить и перезапуск
    // приложения — иначе отменённое тихо вернулось бы в контекст.
    if (existing?.rewound) {
      try {
        existing.abort.abort()
        existing.input.close()
      } catch {
        /* сессия могла уже умереть */
      }
      this.sessions.delete(requestId)
    } else if (existing?.input.isClosed()) {
      this.sessions.delete(requestId)
    } else if (existing) {
      // Re-sync the per-session bypass to the current global (dispatchClaude
      // passes the live setting every turn) so a background session can't keep a
      // stale bypass flag that contradicts what the chip shows.
      existing.bypass = !!opts.bypass
      existing.editsAuto = !!opts.editsAuto
      // The renderer sends the committed model/effort/ultracode with EVERY
      // turn. Applying the ones that actually changed is what lets a pick made
      // while another tab was focused reach this session — the launch console's
      // live setters only address the active conversation, so without this a
      // background session kept its start-time model for the rest of its life.
      const ultra = !!opts.ultracode
      if (ultra !== !!existing.ultracode) {
        this.setUltracode(requestId, ultra)
        existing.ultracode = ultra
        // Ultracode owns effortLevel (pins xhigh on, clears it off).
        existing.effort = ultra ? 'xhigh' : undefined
      }
      if (!ultra && opts.effort !== existing.effort) {
        this.setEffort(requestId, opts.effort)
        existing.effort = opts.effort
      }
      if (opts.model !== existing.model) {
        this.setModel(requestId, opts.model)
        existing.model = opts.model
      }
      // A new turn means the session is being used again: clear the «the user
      // interrupted» flag, or one Esc would silence every later failure for the
      // rest of this conversation and the UI would wait forever.
      existing.interrupted = false
      // Last line of defence: if the queue closed between the check above and
      // here, don't pretend the turn started.
      if (!existing.input.push(userMessage(opts.prompt, opts.images))) {
        this.sessions.delete(requestId)
        this.emit(requestId, {
          type: 'error',
          message: tm('drv.sessionEnded')
        })
      }
      return
    }

    let sdk: typeof import('@anthropic-ai/claude-agent-sdk')
    try {
      sdk = await loadSdk('@anthropic-ai/claude-agent-sdk')
    } catch (e) {
      this.emit(requestId, {
        type: 'error',
        message: tm('drv.sdkFail', { err: e instanceof Error ? e.message : String(e) })
      })
      return
    }

    const abort = new AbortController()
    const input = createInputQueue()
    const perms = new Map<string, (r: PermissionResult | null) => void>()
    // The extracted questions per AskUserQuestion toolUseId, so resolveQuestion
    // can rebuild the Claude answer envelope ({questions, answers}) from the
    // generic AgentQuestionAnswer the renderer sends.
    const pendingQuestions = new Map<string, ClaudeCliQuestion[]>()

    const canUseTool: CanUseTool = async (toolName, toolInput, ctx) =>
      new Promise<PermissionResult | null>((resolve) => {
        const isQuestion = toolName === 'AskUserQuestion'
        // Bypass ('без спроса') auto-approves ordinary tools with no prompt — but
        // AskUserQuestion is the agent asking the USER, so we ALWAYS surface the
        // widget and never auto-answer it, even in bypass. We keep permissionMode
        // 'default' (not 'bypassPermissions') precisely so canUseTool is always
        // consulted here, which keeps the question widget working in every mode.
        /*
         * Пол под автопилотом.
         *
         * Автопилот означает «не спрашивай про рутину», а не «делай что
         * угодно»: `rm -rf`, `push --force`, `DROP TABLE` показываются всегда.
         * Разница между «переспросил зря» и «день работы пропал» слишком
         * велика, чтобы отдавать её тумблеру.
         *
         * Это НЕ песочница и не защита: изоляции у Зари нет, и то же удаление
         * внутри скрипта сюда не попадёт. Это список того, что нельзя отменить
         * — и обещание показать его перед запуском, не более.
         */
        const stop = irreversible(toolName, toolInput)
        /*
         * Пометку сервера тоже пропускаем через пол.
         *
         * Если сторонний сервер САМ объявил инструмент разрушающим, проглотить
         * его молча — ровно то, от чего пол и существует. Мы за эту пометку не
         * ручаемся (сервер вправе ошибиться или не заполнить её вовсе), поэтому
         * карточка называет источник. Сервер, который метит разрушающим всё
         * подряд, делает автопилот бесполезным — но это видно, и такой сервер
         * можно выключить целиком во вкладке «Инструменты».
         *
         * Пометки нет в карте (первый гейт опередил её) — ведём себя как
         * раньше: обещать то, чего ещё не знаем, нельзя.
         */
        const mark = this.mcpMarks.get(requestId)?.[toolName]
        /*
         * Ступень между «спрашивай всё» и автопилотом: правки файлов идут
         * молча, команды оболочки и сеть — по-прежнему с вопросом. Это рабочий
         * режим рефакторинга, где иначе человек двадцать раз подряд отвечает
         * «да» на правку одного и того же файла и перестаёт читать карточки.
         *
         * Держим ЗДЕСЬ, а не в `permissionMode: 'acceptEdits'` движка. Тот
         * пропускает правки ниже `canUseTool` — то есть мимо Зари: карточка не
         * появляется, «поле необратимого» не работает, и на экране не остаётся
         * следа. Наш вариант проходит тот же путь, что и все прочие вызовы, и
         * потому подчиняется тем же правилам.
         */
        const sess = this.sessions.get(requestId)
        const autoEdit = !!sess?.editsAuto && isEditTool(toolName) && !mark?.destructive
        if (!isQuestion && !stop && !mark?.destructive && (sess?.bypass || autoEdit)) {
          resolve({ behavior: 'allow' })
          return
        }
        perms.set(ctx.toolUseID, resolve)
        if (isQuestion) pendingQuestions.set(ctx.toolUseID, extractQuestions(toolInput) ?? [])
        this.emit(requestId, {
          type: 'permission',
          toolUseId: ctx.toolUseID,
          toolName,
          input: toolInput,
          title: ctx.title,
          displayName: ctx.displayName,
          questions: isQuestion ? extractQuestions(toolInput) : undefined,
          irreversible: stop ?? undefined,
          // Чем сервер пометил свой инструмент. Известно сразу для всех, кроме
          // самого первого MCP-гейта сессии: карту пометок собираем в фоне с
          // init. Опоздала — карточка выйдет без пометки и дополнится, когда
          // карта придёт (см. ниже).
          mcpMark: mark
        })
        /*
         * Первый MCP-гейт может опередить карту пометок. Ждать её в canUseTool
         * значило бы задержать саму карточку — а карточка нужна человеку
         * немедленно. Поэтому досылаем пометку отдельным событием: гейт всё
         * равно ждёт решения, и она успеет к моменту, когда человек читает.
         */
        if (!isQuestion && toolName.startsWith('mcp__') && !this.mcpMarks.get(requestId)) {
          void this.ensureMcpMarks(requestId).then((marks) => {
            const mark = marks?.[toolName]
            if (mark) this.emit(requestId, { type: 'tool-mark', toolUseId: ctx.toolUseID, mcpMark: mark })
          })
        }
        ctx.signal.addEventListener('abort', () => {
          if (perms.delete(ctx.toolUseID)) resolve({ behavior: 'deny', message: tm('drv.aborted') })
        })
      })

    const exePath = (await claudeExe()).path
    /**
     * Продолжение беседы. Обычный случай — `resume` по id сессии. После отмены
     * отправленного сообщения рендерер добавляет `resumeAt`: берём историю ДО
     * этого ответа включительно и уходим ВЕТКОЙ. Без forkSession продолжение
     * дописывало бы прежнюю ветку, и отменённое вернулось бы в контекст.
     */
    const resumeOpts: Partial<Options> = !opts.resume
      ? {}
      : opts.resumeAt
        ? { resume: opts.resume, resumeSessionAt: opts.resumeAt, forkSession: true }
        : { resume: opts.resume }
    const options: Options = {
      cwd: opts.cwd,
      abortController: abort,
      canUseTool,
      // Always 'default' (or acceptEdits/plan) — never 'bypassPermissions'. Bypass
      // is implemented as an auto-allow inside canUseTool instead, so the callback
      // is never shadowed (AskUserQuestion keeps working) and no SDK
      // CAN_USE_TOOL_SHADOWED warning is emitted. Whitelist here at the trust
      // boundary so a stray/hostile permissionMode can never re-enable shadowing.
      permissionMode: SAFE_PERMISSION_MODES.has(opts.permissionMode as string)
        ? (opts.permissionMode as 'default' | 'acceptEdits' | 'plan')
        : 'default',
      // Ответ печатается на глазах. Куски идут пачками (см. queueDelta) и в
      // историю беседы НЕ попадают — там остаётся целое сообщение движка.
      includePartialMessages: true,
      stderr: (data) => {
        // The bundled CLI writes interactive-picker keybinding hints and other TUI
        // chatter to stderr even in headless mode — pure noise in a GUI. Keep it
        // out of the console by default; real failures already surface as 'error'
        // events. Opt in with ZARYA_DEBUG=1 when debugging the subprocess.
        if (process.env.ZARYA_DEBUG) console.error('[claude-code]', data.trim())
      },
      ...(exePath ? { pathToClaudeCodeExecutable: exePath } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort as Options['effort'] } : {}),
      // Ultracode is a flag-settings toggle (xhigh + workflow orchestration).
      ...(opts.ultracode
        ? { settings: { ultracode: true, effortLevel: 'xhigh' } as Options['settings'] }
        : {}),
      ...resumeOpts
    }
    // Remember the effort override so init reports the effective value.
    const effortOverride = opts.effort

    input.push(userMessage(opts.prompt, opts.images))
    let query: Query
    try {
      query = sdk.query({ prompt: input.iterable, options })
    } catch (e) {
      this.emit(requestId, {
        type: 'error',
        message: tm('drv.ccFail', { err: e instanceof Error ? e.message : String(e) })
      })
      return
    }

    const session: Session = {
      query,
      input,
      abort,
      perms,
      pendingQuestions,
      // В какой папке эта беседа. Нужно не самой сессии, а наблюдателю за
      // скиллами и MCP: `.mcp.json` и `.claude/skills` лежат в проекте, и
      // следить надо за папками ПАНЕЛЕЙ, а не за папкой, из которой запустили
      // приложение.
      cwd: opts.cwd,
      bypass: !!opts.bypass,
      editsAuto: !!opts.editsAuto,
      effort: effortOverride,
      model: opts.model,
      ultracode: !!opts.ultracode,
      shellTasks: new Set<string>(),
      taskKinds: new Map<string, string>(),
      resumed: !!opts.resume,
      // Ветка запомнила, откуда началась: если человек нажмёт Esc и здесь, до
      // первого слова агента, отматывать будем к той же точке.
      ...(opts.resume && opts.resumeAt
        ? { forkBase: { sessionId: opts.resume, at: opts.resumeAt } }
        : {})
    }
    this.sessions.set(requestId, session)
    if (session.cwd) {
      this.lastCwd.set(requestId, session.cwd)
      // Столько же, сколько снимков: беседы за день копятся, а папка нужна
      // только недавним. Мусора не оставляем даже в памяти.
      if (this.lastCwd.size > 8) this.lastCwd.delete(this.lastCwd.keys().next().value as string)
    }

    void this.pump(requestId, session)
    // Пометки инструментов спрашиваем сразу и в фоне: к первому гейту карта
    // должна быть уже на руках, иначе именно первое одобрение — то самое, где
    // человек ещё не знает, чего ждать от нового сервера, — выйдет без неё.
    void this.ensureMcpMarks(requestId)
  }

  /**
   * Копить куски ответа и отдавать их пачками.
   *
   * Движок шлёт дельты по нескольку слов — на длинном ответе это сотни
   * сообщений через IPC в секунду, и лента, самое дорогое место на экране,
   * перерисовывалась бы на каждое. Пачка раз в {@link DELTA_MS} читается глазом
   * как ровная печать и стоит два десятка сообщений в секунду вместо сотен.
   */
  private queueDelta(requestId: string, session: Session, chunk: string): void {
    session.deltaBuf = (session.deltaBuf ?? '') + chunk
    if (session.deltaTimer) return
    session.deltaTimer = setTimeout(() => {
      session.deltaTimer = undefined
      this.flushDelta(requestId, session)
    }, DELTA_MS)
  }

  /** Отдать накопленное немедленно — и снять таймер, чтобы не отдать дважды. */
  private flushDelta(requestId: string, session: Session): void {
    if (session.deltaTimer) {
      clearTimeout(session.deltaTimer)
      session.deltaTimer = undefined
    }
    const text = session.deltaBuf
    session.deltaBuf = undefined
    if (text) this.emit(requestId, { type: 'text_delta', text })
  }

  /** Drain the query's message stream, translating each into a ClaudeStreamEvent. */
  private async pump(requestId: string, session: Session): Promise<void> {
    try {
      for await (const msg of session.query as AsyncIterable<SDKMessage>) {
        // Ход отменён (Esc над отправленным): всё, что сессия скажет дальше,
        // относится к сообщению, которого в беседе больше нет — включая уже
        // сочинённый ответ на него. Поток при этом дочитываем: оборвать цикл
        // значило бы снять сессию с учёта в finally, и убить процесс при
        // следующем ходе стало бы некому.
        if (session.rewound) continue
        /*
         * Любое сообщение после «гашу рабочий процесс» означает, что гашения не
         * было: предупреждение оказалось историческим (возобновлённая беседа
         * тащит его посреди потока) и до экрана дойти не должно.
         */
        if (
          this.workerDownTimer &&
          (msg as unknown as { subtype?: string }).subtype !== 'worker_shutting_down'
        ) {
          clearTimeout(this.workerDownTimer)
          this.workerDownTimer = undefined
        }
        switch (msg.type) {
          /*
           * ОТВЕТ, КОТОРЫЙ ПЕЧАТАЕТСЯ НА ГЛАЗАХ.
           *
           * Раньше `includePartialMessages` стоял в `false`, и на длинном
           * ответе человек смотрел на три точки, пока весь текст не прилетал
           * разом: по экрану нельзя было отличить «пишет» от «завис».
           *
           * Кусок — это ПОКАЗ, а не история. Настоящим текстом остаётся тот,
           * что придёт целым сообщением в конце (`case 'assistant'`), и только
           * он ложится в беседу. Иначе оборванный на середине поток осел бы в
           * памяти как ответ агента — Заря помнила бы то, чего он не говорил.
           */
          case 'stream_event': {
            const p = msg as unknown as {
              parent_tool_use_id?: string | null
              event?: { type?: string; delta?: { type?: string; text?: string } }
            }
            // Кусок от СУБАГЕНТА (`parent_tool_use_id` не пуст) в главный ответ
            // не идёт: его слова — не слова агента, с которым говорит человек,
            // и вперемешку они читались бы как один сбивчивый текст.
            if (p.parent_tool_use_id) break
            if (p.event?.type !== 'content_block_delta') break
            if (p.event.delta?.type !== 'text_delta') break
            const chunk = p.event.delta.text
            if (typeof chunk === 'string' && chunk) this.queueDelta(requestId, session, chunk)
            break
          }
          case 'system': {
            /*
             * СЖАТИЕ КОНТЕКСТА. В консоли на этом месте строка и полоса
             * загрузки; в Заре не было ничего — агент просто «забывал» разговор,
             * и объяснения на экране не находилось.
             *
             * Два события: статус (идёт прямо сейчас) и граница (закончилось, и
             * тогда известны числа). Числа берём у движка — своей арифметики
             * поверх не изобретаем.
             */
            if (msg.subtype === 'status') {
              const st = msg as unknown as {
                status?: string
                compact_result?: string
                compact_error?: string
              }
              if (st.status === 'compacting') {
                this.emit(requestId, { type: 'compact', phase: 'running' })
              } else if (st.compact_result === 'success') {
                this.emit(requestId, { type: 'compact', phase: 'done' })
              } else if (st.compact_result === 'failed') {
                this.emit(requestId, {
                  type: 'compact',
                  phase: 'failed',
                  error: st.compact_error
                })
              }
              break
            }
            if (msg.subtype === 'compact_boundary') {
              const m = (msg as unknown as {
                compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number }
              }).compact_metadata
              this.emit(requestId, {
                type: 'compact',
                phase: 'done',
                before: typeof m?.pre_tokens === 'number' ? m.pre_tokens : undefined,
                after: typeof m?.post_tokens === 'number' ? m.post_tokens : undefined,
                auto: m?.trigger === 'auto'
              })
              break
            }
            /*
             * СЛУЖЕБНЫЕ СТРОКИ ДВИЖКА: отказ модели (с переходом на запасную и
             * без), баннеры и ответы хуков. Раньше всё это проваливалось в
             * пустой `break` — и отказ выглядел на экране как зависание.
             */
            if (msg.subtype === 'model_refusal_fallback' || msg.subtype === 'model_refusal_no_fallback') {
              // Слова движка лежат в `content` (не в `message` — на этом можно
              // молча потерять всю причину и показать общую заглушку вместо
              // объяснения). `api_refusal_explanation` — запасной источник:
              // старый CLI шлёт его, а `content` может прийти пустым.
              const r = msg as unknown as {
                content?: string
                api_refusal_explanation?: string | null
              }
              this.emit(requestId, {
                type: 'notice',
                level: msg.subtype === 'model_refusal_no_fallback' ? 'error' : 'warn',
                text: r.content?.trim() || r.api_refusal_explanation?.trim() || tm('drv.refusal')
              })
              break
            }
            if (msg.subtype === 'informational') {
              const n = msg as unknown as {
                content?: string
                level?: string
                prevent_continuation?: boolean
              }
              const text = n.content?.trim()
              /*
               * Служебный шум («info») в ленту не тащим: движок сам помечает
               * такие строки как «видно только в расшифровке». Но если после
               * строки работа ОСТАНАВЛИВАЕТСЯ (`prevent_continuation` — хук
               * запретил продолжать), она показывается при любом уровне: это
               * единственное объяснение того, почему ход кончился молча.
               */
              const stops = n.prevent_continuation === true
              if (text && (stops || n.level !== 'info')) {
                this.emit(requestId, {
                  type: 'notice',
                  level: stops || n.level === 'warning' ? 'warn' : 'info',
                  text
                })
              }
              break
            }
            /*
             * ТО, О ЧЁМ ДВИЖОК ГОВОРИЛ В ПУСТОТУ.
             *
             * Повтор запроса после ошибки API, отказ инструменту по правилу, ответ
             * локальной слэш-команды, упавший хук, гашение рабочего процесса — всё
             * это приходило сюда и проваливалось в пустой `break`. Разбор — в
             * `systemNotices.ts`: там он проверяется построчно, здесь достаточно
             * одного вопроса «есть ли что сказать».
             */
            if (isNoticeSubtype(msg.subtype)) {
              const notice = noticeFor(msg)
              if (!notice) break
              /*
               * «Гашу рабочий процесс» — сигнал живого хвоста, а не факт сессии.
               * Типы SDK предупреждают прямо: возобновлённая беседа тащит с
               * собой ИСТОРИЧЕСКИЕ такие сообщения посреди потока. Показать их
               * дословно значит объявить обрыв связи там, где следом спокойно
               * приходит ответ, — а предупреждение, за которым ничего не
               * следует, учит не читать предупреждения.
               *
               * Поэтому придерживаем на полторы секунды: пришло что угодно
               * следующее — сообщение снимается само.
               */
              if (msg.subtype === 'worker_shutting_down') {
                clearTimeout(this.workerDownTimer)
                this.workerDownTimer = setTimeout(() => {
                  this.workerDownTimer = undefined
                  this.emit(requestId, { type: 'notice', ...notice })
                }, 1500)
                break
              }
              this.emit(requestId, { type: 'notice', ...notice })
              break
            }
            /*
             * ЗАДАЧИ ДВИЖКА: субагенты, воркфлоу, фоновые команды.
             *
             * Числа (токены, вызовы, время) считает сам SDK — мы их передаём, а
             * не выводим сами: показатель, расходящийся с действительностью,
             * хуже отсутствующего.
             *
             * ЧТО ПРЯЧЕМ. Раньше здесь стоял белый список: всё, кроме
             * `local_agent`, замолкало НАВСЕГДА. Под тот же нож попал `Workflow`
             * (у него род `local_workflow`) — человек видел «запущено в фоне» и
             * дальше тишину. Теперь наоборот: прячем только то, что движок сам
             * пометил служебным (`skip_transcript` — его прямое указание «не
             * показывай в ленте»), и обычные команды оболочки. Незнакомый род
             * задачи ПОКАЗЫВАЕТСЯ: молчание о новом — та же ошибка второй раз.
             */
            if (
              msg.subtype === 'task_started' ||
              msg.subtype === 'task_progress' ||
              msg.subtype === 'task_updated' ||
              msg.subtype === 'task_notification'
            ) {
              const t = msg as unknown as {
                subtype: string
                task_id?: string
                tool_use_id?: string
                description?: string
                subagent_type?: string
                task_type?: string
                workflow_name?: string
                last_tool_name?: string
                status?: string
                summary?: string
                skip_transcript?: boolean
                patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean }
                usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
              }
              const taskId = t.task_id
              if (taskId) {
                if (t.subtype === 'task_started') {
                  if (taskHidden(t.task_type, t.skip_transcript)) {
                    // Запомнить, чтобы и последующие события этой задачи прошли
                    // мимо: род приходит только в момент запуска.
                    session.shellTasks.add(taskId)
                  } else {
                    session.taskKinds.set(taskId, t.task_type ?? '')
                  }
                }
                if (!session.shellTasks.has(taskId)) {
                  const status = taskOutcome(t.subtype, t.status, t.patch?.status)
                  const done = taskDone(t.subtype, status)
                  this.emit(requestId, {
                    type: 'subagent',
                    taskId,
                    toolUseId: t.tool_use_id,
                    phase: t.subtype === 'task_started' ? 'started' : done ? 'done' : 'progress',
                    description: t.description ?? t.patch?.description,
                    subagentType: t.subagent_type,
                    totalTokens: t.usage?.total_tokens,
                    toolUses: t.usage?.tool_uses,
                    durationMs: t.usage?.duration_ms,
                    lastTool: t.last_tool_name,
                    status,
                    // Слова движка о том, чем всё кончилось. У неудачи это
                    // `patch.error` — единственное объяснение, которое вообще
                    // приходит.
                    summary: t.summary?.trim() || t.patch?.error?.trim() || undefined,
                    taskType: session.taskKinds.get(taskId) || undefined,
                    workflowName: t.workflow_name,
                    backgrounded: t.patch?.is_backgrounded
                  })
                }
              }
              break
            }
            if (msg.subtype === 'init') {
              this.emit(requestId, {
                type: 'init',
                sessionId: (session.claudeSessionId = msg.session_id),
                model: msg.model,
                cwd: msg.cwd,
                permissionMode: msg.permissionMode,
                tools: msg.tools,
                effort: session.effort ?? readClaudeEffort()
              })
              // Pull the usage gauge right away so it's visible while working,
              // and keep it refreshed on a light poll (account-wide value).
              void this.fetchUsage(requestId, session)
              this.ensureUsagePoll()
              // Fetch the dynamic model catalog (future-proof: no hardcoded list).
              void this.fetchModels(requestId, session)
            }
            break
          }

          /*
           * ИНСТРУМЕНТ ЖИВ — сердцебиение движка.
           *
           * Секундомер карточки идёт сам по себе: он честно считает, сколько мы
           * ждём, но ничего не знает о том, работает процесс или повис. Пульс
           * знает — самим фактом своего прихода.
           *
           * Пульс СУБАГЕНТА пропускаем: его инструменты в ленте не карточками, а
           * одной строкой волны, и подтверждать жизнь того, чего на экране нет,
           * незачем. Повтор подзадачи при этом приходит на карточке самого
           * `Task` (у неё `parent_tool_use_id` пуст) и до экрана доходит.
           */
          case 'tool_progress': {
            const p = msg as unknown as {
              tool_use_id?: string
              parent_tool_use_id?: string | null
              elapsed_time_seconds?: number
              subagent_retry?: { attempt?: number; max_retries?: number }
            }
            if (p.parent_tool_use_id) break
            const id = p.tool_use_id
            if (!id) break
            const attempt = p.subagent_retry?.attempt
            const max = p.subagent_retry?.max_retries
            this.emit(requestId, {
              type: 'tool_pulse',
              toolUseId: id,
              elapsedSec: numOr(p, 'elapsed_time_seconds') ?? 0,
              // Повтор показываем только когда движок назвал ОБА числа: «попытка
              // 2 из неизвестно скольких» пугает, ничего не объясняя.
              retry:
                typeof attempt === 'number' && typeof max === 'number'
                  ? { attempt, max }
                  : undefined
            })
            break
          }

          case 'rate_limit_event': {
            const info = (
              msg as {
                rate_limit_info?: {
                  utilization?: number
                  resetsAt?: number
                  rateLimitType?: string
                }
              }
            ).rate_limit_info
            if (info?.utilization !== undefined) {
              // SDKRateLimitInfo.utilization is already a 0-100 percentage (same
              // scale as the /usage endpoint) — no ×100. resetsAt is a Unix
              // timestamp; normalize seconds → ms so the countdown is correct.
              const pct = info.utilization
              const resetsMs =
                info.resetsAt != null
                  ? info.resetsAt < 1e12
                    ? info.resetsAt * 1000
                    : info.resetsAt
                  : undefined
              const isWeekly = (info.rateLimitType ?? '').startsWith('seven_day')
              this.emit(requestId, {
                type: 'usage',
                usage: isWeekly
                  ? { sevenDayPct: pct, sevenDayResetsAt: resetsMs }
                  : { fiveHourPct: pct, fiveHourResetsAt: resetsMs }
              })
            }
            break
          }

          case 'assistant': {
            // A subagent's own steps are NOT the main transcript. They arrive
            // marked with parent_tool_use_id, and dumping them inline made the
            // feed look like the main agent had run a dozen Globs itself. The
            // wave line summarises them: how many, how long, what they cost and
            // which tool each is on right now.
            if (msg.parent_tool_use_id) break
            // Точка отмотки: продолжать беседу можно только с ответа агента —
            // так требует resumeSessionAt.
            const uuid = (msg as unknown as { uuid?: string }).uuid
            if (uuid) session.lastAssistantUuid = uuid
            // Недосланные куски — на экран ДО настоящего сообщения: иначе
            // хвост печати мигнул бы поверх уже пришедшего ответа.
            this.flushDelta(requestId, session)
            const content = mapAssistantContent((msg.message as { content?: unknown }).content)
            if (content.length) this.emit(requestId, { type: 'assistant', content })
            /*
             * ХОД ОБОРВАЛСЯ. `aborted` движок ставит, когда поток кончился до
             * `stop_reason`: прервали, упёрлись в предел вывода, отказала
             * модель. Раньше это не читалось нигде, и при пустом `content` по
             * ходу не приходило НИ ОДНОГО события — «думающие» точки просто
             * гасли. На экране это неотличимо от зависания: человек ждёт
             * ответа, которого уже не будет.
             */
            if ((msg as unknown as { aborted?: boolean }).aborted) {
              this.emit(requestId, {
                type: 'notice',
                level: 'warn',
                text: content.length ? tm('drv.abortedTail') : tm('drv.abortedEmpty')
              })
            }
            break
          }

          case 'user': {
            // Same for a subagent's tool results — its card was never rendered.
            if (msg.parent_tool_use_id) break
            // Only surface tool_result blocks — the user's own prompt is already
            // shown by the renderer (it initiated the turn).
            const content = (msg.message as { content?: unknown }).content
            if (Array.isArray(content)) {
              for (const b of content as Array<Record<string, unknown>>) {
                if (b.type === 'tool_result') {
                  this.emit(requestId, {
                    type: 'tool_result',
                    toolUseId: String(b.tool_use_id ?? ''),
                    content: toolResultText(b.content),
                    isError: !!b.is_error
                  })
                }
              }
            }
            break
          }

          case 'result': {
            // The turn finished on its own, so the session is healthy again: a
            // later crash must be reported, not swallowed as «that Esc earlier».
            session.interrupted = false
            const modelUsage =
              (msg as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {}
            this.emit(requestId, {
              type: 'result',
              isError: msg.is_error,
              result: 'result' in msg ? msg.result : undefined,
              costUsd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
              numTurns: 'num_turns' in msg ? msg.num_turns : undefined,
              // Id живой сессии, а не тот, что назвал result. После ветки
              // (forkSession) SDK возвращает здесь ИСХОДНУЮ сессию, и рендерер,
              // поверив ей, возобновил бы на следующем ходу неотмотанную
              // историю — вместе с отменённым сообщением. Что реально открыто,
              // знает init.
              sessionId: session.claudeSessionId ?? msg.session_id,
              models: Object.keys(modelUsage),
              /*
               * Числа хода и его исход. Движок считает их сам и присылал всегда
               * — Заря брала только флаг ошибки, и «сколько это длилось» и «а
               * почему оно вообще кончилось» человек узнать не мог.
               */
              durationMs: numOr(msg, 'duration_ms'),
              ttftMs: numOr(msg, 'ttft_ms') ?? numOr(msg, 'ttft_stream_ms'),
              endReason: endReasonText(msg) || undefined,
              denials:
                (msg as unknown as { permission_denials?: unknown[] }).permission_denials?.length ||
                undefined
            })
            // Context-window fill: this turn's context tokens (fresh input + both
            // cache tiers) against the model's window, so the gauge reads how full
            // the conversation context is.
            const u = (
              msg as {
                usage?: {
                  input_tokens?: number
                  cache_read_input_tokens?: number
                  cache_creation_input_tokens?: number
                }
              }
            ).usage
            const ctxWindow = Math.max(
              0,
              ...Object.values(modelUsage).map((m) => m?.contextWindow ?? 0)
            )
            const ctxTokens =
              (u?.input_tokens ?? 0) +
              (u?.cache_read_input_tokens ?? 0) +
              (u?.cache_creation_input_tokens ?? 0)
            if (ctxWindow > 0 && ctxTokens > 0) {
              this.emit(requestId, {
                type: 'usage',
                usage: {
                  contextTokens: ctxTokens,
                  contextWindow: ctxWindow,
                  contextPct: Math.min(100, (ctxTokens / ctxWindow) * 100)
                }
              })
            }
            // Refresh the subscription usage gauge after each completed turn.
            void this.fetchUsage(requestId, session)
            break
          }

          /*
           * ДВИЖОК ЗАБЫЛ РАЗГОВОР.
           *
           * Приходит от `/clear`, от выхода из режима плана и при старте новой
           * сессии: движок заводит беседу заново, под новым номером. Заря об
           * этом не знала — и продолжала показывать ленту, которой агент уже не
           * помнит, а следующий ход уходил с прежним номером сессии. То есть
           * интерфейс утверждал, что память на месте, когда её нет: ровно та
           * ложь, которой здесь не должно быть.
           *
           * Ленту НЕ стираем: это записи человека, а не агента, и терять их
           * из-за чужой забывчивости нельзя. Ставим черту и говорим словами.
           */
          case 'conversation_reset': {
            const fresh = (msg as unknown as { new_conversation_id?: string }).new_conversation_id
            session.claudeSessionId = fresh
            this.emit(requestId, { type: 'reset', sessionId: fresh })
            break
          }

          default:
            // partial-assistant / status / hook / task / etc. — ignored for now
            break
        }
      }
    } catch (e) {
      // A process that exits because the user pressed Esc is not an error to
      // report — it is the thing they just asked for.
      if (!session.abort.signal.aborted && !session.interrupted && !session.rewound) {
        this.emit(requestId, {
          type: 'error',
          message: e instanceof Error ? e.message : String(e)
        })
      }
    } finally {
      // Только СВОЮ запись: сессия, которую отменили и заменили, доживает
      // асинхронно, и слепой delete снял бы с учёта уже новый процесс.
      if (this.sessions.get(requestId) === session) this.sessions.delete(requestId)
      // Fail any still-pending permission prompts so the SDK isn't left hanging.
      for (const resolve of session.perms.values()) resolve(null)
      session.perms.clear()
      // Недосланный кусок печати уже не нужен: целое сообщение либо пришло,
      // либо не придёт вовсе. Отдать его сейчас значило бы дописать в ленту
      // обрывок фразы после того, как ход закончился.
      if (session.deltaTimer) clearTimeout(session.deltaTimer)
      session.deltaTimer = undefined
      session.deltaBuf = undefined
    }
  }

  /** Pull the /usage snapshot (subscription rate-limit windows) after a turn. */
  private async fetchUsage(requestId: string, session: Session): Promise<void> {
    if (session.rewound) return
    try {
      const q = session.query as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
      }
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof fn !== 'function') return
      const resp = await fn.call(session.query)
      const usage = usageFromResponse(resp)
      if (
        usage.fiveHourPct !== undefined ||
        usage.sevenDayPct !== undefined ||
        usage.subscriptionType
      ) {
        this.emit(requestId, { type: 'usage', usage })
      }
    } catch {
      // Experimental API — best-effort, ignore failures.
    }
  }

  private standaloneUsageBusy = false
  /**
   * Run a callback against a throwaway idle Agent-SDK query (no prompt pushed),
   * then tear it down. Backs the standalone usage/model fetchers so the fuel
   * gauge and model catalog are fresh before any session exists. Best-effort:
   * returns undefined on any failure (experimental API / offline / API-key).
   */
  private async withIdleQuery<T>(use: (query: unknown) => Promise<T>): Promise<T | undefined> {
    let input: ReturnType<typeof createInputQueue> | undefined
    let timer: NodeJS.Timeout | undefined
    const abort = new AbortController()
    try {
      const sdk = await loadSdk('@anthropic-ai/claude-agent-sdk')
      input = createInputQueue()
      const exePath = (await claudeExe()).path
      const query = sdk.query({
        prompt: input.iterable,
        options: {
          abortController: abort,
          permissionMode: 'default',
          includePartialMessages: false,
          stderr: () => {},
          ...(exePath ? { pathToClaudeCodeExecutable: exePath } : {})
        }
      })
      // The SDK's control requests (supportedModels/usage) have NO deadline of
      // their own: a child that starts but never answers would leave this await
      // pending forever — the process would never be aborted and the callers'
      // in-flight guards would latch, freezing the catalog and the fuel poll
      // until the app restarts. Race a timeout so this ALWAYS settles and the
      // finally below actually runs.
      return await Promise.race([
        use(query),
        new Promise<undefined>((res) => {
          timer = setTimeout(() => res(undefined), IDLE_QUERY_TIMEOUT_MS)
        })
      ])
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
      try {
        input?.close()
      } catch {
        /* ignore */
      }
      try {
        abort.abort()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Fetch /usage WITHOUT an active conversation, so the fuel gauge is accurate
   * at startup and on demand (before the first prompt). Broadcast under
   * requestId '__usage__' — the renderer applies usage to the ambient Claude
   * status ahead of its conv-existence gate. Best-effort: fails silently for
   * API-key/3P sessions where rate limits don't apply.
   */
  async fetchUsageStandalone(): Promise<void> {
    if (this.standaloneUsageBusy) return
    // A live session's poll already covers this — don't spawn a second process.
    if (this.sessions.size > 0) return
    this.standaloneUsageBusy = true
    try {
      await this.withIdleQuery(async (query) => {
        const q = query as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
        }
        const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
        if (typeof fn !== 'function') return
        const usage = usageFromResponse(await fn.call(q))
        if (
          usage.fiveHourPct !== undefined ||
          usage.sevenDayPct !== undefined ||
          usage.subscriptionType
        ) {
          this.emit('__usage__', { type: 'usage', usage })
        }
      })
    } finally {
      this.standaloneUsageBusy = false
    }
  }

  /**
   * Background usage polling so the fuel gauge is fresh from app boot — before
   * any prompt — and stays current ~once a minute. Fires once immediately, then
   * on an interval; each tick no-ops when a live session's own poll already
   * covers usage (so it never spawns a second process while you're working).
   */
  startAmbientUsagePoll(): void {
    if (this.ambientTimer) return
    void this.fetchUsageStandalone()
    this.ambientTimer = setInterval(() => void this.fetchUsageStandalone(), 60_000)
  }

  /** Enqueue a follow-up user turn on an existing session. */
  input(requestId: string, text: string): void {
    this.sessions.get(requestId)?.input.push(userMessage(text))
  }

  /** Fetch the dynamic model catalog from a live session and emit it. */
  private async fetchModels(requestId: string, session: Session): Promise<void> {
    if (session.rewound) return
    try {
      const q = session.query as unknown as {
        supportedModels?: () => Promise<Array<Record<string, unknown>>>
      }
      const list = (await q.supportedModels?.()) ?? []
      const models = mapModelList(list)
      if (models.length) this.emit(requestId, { type: 'models', models })
    } catch {
      // supported-models unavailable — the renderer keeps its fallback list.
    }
  }

  /**
   * Команды движка для палитры «/».
   *
   * В отличие от моделей, здесь снимок живой сессии — ПРАВИЛЬНЫЙ источник:
   * `supportedCommands()` в рантайме возвращает `latestCommands ?? initial`, а
   * `latestCommands` обновляется push-сообщением `commands_changed` (SDK шлёт
   * его, когда агент нашёл скиллы в подкаталоге или поставили плагин). Поэтому
   * спрашиваем живую сессию, если она есть, и поднимаем холостую, только когда
   * бесед нет вовсе — до первого запроса человека список уже нужен.
   */
  /** В какой папке работает беседа. Пусто — беседы нет или она уже закрыта. */
  sessionCwd(requestId: string): string | undefined {
    return this.sessions.get(requestId)?.cwd
  }

  /**
   * Команды ЭТОЙ беседы.
   *
   * Раньше бралась первая сессия из Map — то есть при четырёх панелях в трёх
   * проектах список приходил от случайной из них, и человек видел в «/» скиллы
   * чужого репозитория. Проектные скиллы лежат в `.claude/skills` рядом с
   * кодом, поэтому набор у панелей разный, и спрашивать надо ту, в которой
   * человек печатает.
   *
   * Беседа не названа: берём живую только если она ОДНА — тогда это не догадка,
   * а единственный возможный ответ. Живых несколько — не гадаем, поднимаем
   * пустой query: список общих команд движка честнее случайного проектного.
   * Совсем ничего нет — тоже пустой query, общие команды полезнее пустоты.
   */
  async listCommands(
    requestId?: string
  ): Promise<import('@shared/agentCommands').AgentCommand[]> {
    const live = requestId
      ? this.sessions.get(requestId)
      : this.sessions.size === 1
        ? this.sessions.values().next().value
        : undefined
    if (live) {
      const list = await this.commandsOf(live.query)
      if (list.length) return list
    }
    const fresh = await this.withIdleQuery(async (query) => this.commandsOf(query))
    return fresh ?? []
  }

  /**
   * Перечитать скиллы, плагины и CLAUDE.md на ЖИВОЙ сессии.
   *
   * Обычный путь после установки MCP-сервера или скилла — «перезапустите
   * сессию», то есть потеряйте контекст разговора и начните заново. SDK умеет
   * лучше: `reloadSkills()` и `reloadPlugins()` заставляют CLI перечитать диск
   * и возвращают обновлённый состав, не трогая ни историю, ни процесс.
   *
   * Возвращает то, что изменилось, — окно должно сказать это словами, а не
   * молча обновить список: человек нажал «подхватить» и обязан узнать, нашлось
   * ли что-нибудь.
   *
   * Перечитывает ТУ беседу, из которой нажали. Раньше бралась первая сессия из
   * Map: человек ставил MCP-сервер в одном проекте, нажимал «подхватить» в его
   * панели, а перечитывалась соседняя — и в его собственной ничего не менялось.
   */
  async reloadExtras(requestId?: string): Promise<{
    ok: boolean
    commands: import('@shared/agentCommands').AgentCommand[]
    plugins: number
    mcpServers: { name: string; status?: string }[]
    errors: number
  }> {
    // Беседа не названа — перечитываем живую только если она ОДНА. Раньше
    // бралась первая из Map: при нескольких панелях это была лотерея, и
    // человек нажимал «подхватить» в своей, а перечитывалась соседняя.
    const entry: [string, Session] | undefined = requestId
      ? this.sessions.has(requestId)
        ? [requestId, this.sessions.get(requestId)!]
        : undefined
      : this.sessions.size === 1
        ? this.sessions.entries().next().value
        : undefined
    // Без живой сессии перечитывать нечего: следующая и так стартует со свежим
    // диском. Честно говорим «нечего перечитывать», а не рисуем успех.
    if (!entry) return { ok: false, commands: [], plugins: 0, mcpServers: [], errors: 0 }
    const q = entry[1].query as unknown as {
      reloadSkills?: () => Promise<unknown>
      reloadPlugins?: () => Promise<{
        commands?: unknown
        plugins?: unknown[]
        mcpServers?: { name: string; status?: string }[]
        error_count?: number
      }>
    }
    try {
      // Скиллы первыми: плагины могут принести свои, и порядок «скиллы, потом
      // плагины» даёт итоговый список, где плагинные не затёрты.
      if (typeof q.reloadSkills === 'function') await q.reloadSkills()
      // После перечитывания состав инструментов другой — карта пометок устарела.
      this.mcpMarks.delete(entry[0])
      const res = typeof q.reloadPlugins === 'function' ? await q.reloadPlugins() : undefined
      const commands = res?.commands
        ? cleanCommands(res.commands)
        : await this.commandsOf(entry[1].query)
      return {
        ok: true,
        commands,
        plugins: Array.isArray(res?.plugins) ? res.plugins.length : 0,
        mcpServers: Array.isArray(res?.mcpServers) ? res.mcpServers : [],
        errors: typeof res?.error_count === 'number' ? res.error_count : 0
      }
    } catch {
      return { ok: false, commands: [], plugins: 0, mcpServers: [], errors: 0 }
    }
  }

  /**
   * Состав и здоровье MCP-серверов ОДНОЙ беседы.
   *
   * Беседа названа не для порядка: `.mcp.json` лежит в папке проекта, а окно
   * контекста принадлежит сессии. Две панели в разных репозиториях видят
   * разные наборы, и отдать набор соседней панели за эту — та самая ложь
   * интерфейса, против которой всё остальное.
   *
   * Живой беседы нет — отдаём прошлый снимок с пометкой `stale`. Поднимать
   * движок ради свежего можно только с `probe`, то есть по нажатию человека:
   * проверка связи ЗАПУСКАЕТ серверы по-настоящему, а это чужие процессы
   * (`uvx`, `npx`, `uv run`) и секунды ожидания на ровном месте.
   */
  async mcpStatus(
    requestId: string | undefined,
    opts?: { probe?: boolean }
  ): Promise<McpSnapshot> {
    const live = requestId ? this.sessions.get(requestId) : undefined
    if (live) {
      const fresh = await this.mcpFromQuery(live.query, live.cwd)
      if (fresh) {
        this.rememberSnapshot(requestId!, fresh)
        return fresh
      }
    }
    const past = requestId ? this.mcpSnapshots.get(requestId) : undefined
    if (!opts?.probe) return past ? { ...past, stale: true } : { servers: [], stale: true }
    const probed = await this.withIdleQuery((query) => this.mcpFromQuery(query))
    if (probed) {
      if (requestId) this.rememberSnapshot(requestId, probed)
      return probed
    }
    return past ? { ...past, stale: true } : { servers: [], stale: true }
  }

  /** Переподключить один сервер живой беседы. */
  /**
   * Остановить одну задачу, не обрывая ход.
   *
   * Мы только ПРОСИМ. Что задача встала, скажет `task_notification` со статусом
   * `stopped` — он придёт обычным потоком и сам поставит в волне свою пометку.
   * Рисовать «остановлено» по успеху этого вызова нельзя: он означает лишь то,
   * что просьба ушла.
   */
  async stopTask(
    requestId: string,
    taskId: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    const live = this.sessions.get(requestId)
    if (!live) return { ok: false, reason: 'no-session' }
    const q = live.query as unknown as { stopTask?: (id: string) => Promise<void> }
    if (typeof q.stopTask !== 'function') return { ok: false, reason: 'unsupported' }
    try {
      await q.stopTask(taskId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async mcpReconnect(
    requestId: string,
    name: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    const live = this.sessions.get(requestId)
    if (!live) return { ok: false, reason: 'no-session' }
    const q = live.query as unknown as { reconnectMcpServer?: (n: string) => Promise<void> }
    if (typeof q.reconnectMcpServer !== 'function') return { ok: false, reason: 'unsupported' }
    try {
      await q.reconnectMcpServer(name)
      return { ok: true }
    } catch (e) {
      // Причина — от движка, дословно: наш пересказ «не получилось» человеку
      // ничего не даёт, а текст SDK обычно называет и хост, и код.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Включить или выключить сервер живой беседы.
   *
   * Пишет в `~/.claude.json` — конфиг ДВИЖКА, не наш, и делает это для текущего
   * проекта. Окно обязано сказать это словами до нажатия.
   */
  async mcpToggle(
    requestId: string,
    name: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    const live = this.sessions.get(requestId)
    if (!live) return { ok: false, reason: 'no-session' }
    const q = live.query as unknown as {
      toggleMcpServer?: (n: string, on: boolean) => Promise<void>
    }
    if (typeof q.toggleMcpServer !== 'function') return { ok: false, reason: 'unsupported' }
    try {
      await q.toggleMcpServer(name, enabled)
      // Состав инструментов изменился — старая карта пометок больше не про эту
      // сессию. Спросим заново при следующем гейте.
      this.mcpMarks.delete(requestId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Переключить состояние скилла.
   *
   * Пишем в ЛИЧНЫЕ настройки движка (`~/.claude/settings.json`) — окно обязано
   * сказать это словами до нажатия: файл чужой, наш там только один ключ.
   * Проектные слои сильнее личного, поэтому перекрытый ключ трогать
   * отказываемся: запись прошла бы успешно и не изменила ничего.
   */
  async skillOverride(
    requestId: string | undefined,
    name: string,
    state: SkillState
  ): Promise<{
    ok: boolean
    error?: string
    /** `unreadable` — файл настроек есть, но не читается: писать поверх нельзя. */
    reason?: 'overridden' | 'unreadable'
    by?: SkillLayer
  }> {
    if (!asSkillState(state)) return { ok: false, error: 'неизвестное состояние' }
    if (!name.trim()) return { ok: false, error: 'скилл без имени' }
    // Папка — у беседы, а не из аргумента: рендерер не должен уметь показать
    // главному процессу произвольный путь и заставить его туда писать. Берём и
    // у мёртвой беседы тоже: настройки проекта никуда не делись оттого, что
    // сессия закрылась, а без них переключатель обещал бы несбыточное.
    const cwd = requestId ? this.cwdOf(requestId) : undefined
    const { layers, broken } = readSkillOverrides(cwd)
    for (const layer of ['project', 'local'] as SkillLayer[]) {
      if (asSkillState(layers[layer]?.[name])) return { ok: false, reason: 'overridden', by: layer }
      // Слой, который не читается, мог запрещать этот скилл — мы не знаем.
      // Записать «успешно» и промолчать значило бы соврать дважды.
      if (broken.includes(layer)) return { ok: false, reason: 'unreadable', by: layer }
    }
    const path = skillSettingsPaths(cwd).user!
    // Читаем ЦЕЛИКОМ и кладём обратно целиком: в файле живут чужие ключи
    // (модель, хуки, плагины), и потерять их правкой скилла недопустимо.
    const read = readSettingsFile(path)
    if (read.kind === 'unreadable') {
      // САМОЕ ВАЖНОЕ МЕСТО ФАЙЛА. Раньше «не смог прочитать» было неотличимо от
      // «файла нет», и запись клала поверх чужого конфига объект из одного
      // ключа: достаточно было BOM от PowerShell или висячей запятой, чтобы
      // человек молча потерял модель, хуки и плагины. Теперь — честный отказ с
      // именем файла: пусть чинит руками, это его файл.
      return { ok: false, reason: 'unreadable', error: path }
    }
    try {
      const cfg = read.kind === 'ok' ? read.value : {}
      await writeJsonAtomic(path, withSkillOverride(cfg, name, state))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Папка беседы — даже если сессия уже закрыта.
   *
   * Настройки проекта живут на диске и не исчезают вместе с сессией. Спрашивать
   * их только у живой беседы значило бы показывать переключатель там, где ключ
   * перекрыт проектом, — кнопку, которая «сработает» и ничего не изменит.
   */
  private cwdOf(requestId: string): string | undefined {
    return this.sessions.get(requestId)?.cwd ?? this.lastCwd.get(requestId)
  }

  /**
   * Карта пометок для беседы: спрашиваем один раз и запоминаем.
   *
   * Инструменты меняются вместе с составом серверов, поэтому карта сбрасывается
   * там же, где меняется состав, — в reloadExtras и mcpToggle.
   */
  private async ensureMcpMarks(
    requestId: string
  ): Promise<Record<string, import('@shared/mcp').McpMark> | undefined> {
    const known = this.mcpMarks.get(requestId)
    if (known) return known
    const flying = this.mcpMarksInFlight.get(requestId)
    if (flying) return flying
    const live = this.sessions.get(requestId)
    if (!live) return undefined
    const task = (async () => {
      try {
        const q = live.query as { mcpServerStatus?: () => Promise<RawMcpStatus[]> }
        if (typeof q.mcpServerStatus !== 'function') return undefined
        const marks = markIndex((await q.mcpServerStatus()) ?? [])
        this.mcpMarks.set(requestId, marks)
        return marks
      } catch {
        return undefined
      } finally {
        this.mcpMarksInFlight.delete(requestId)
      }
    })()
    this.mcpMarksInFlight.set(requestId, task)
    return task
  }

  /** Спросить у одного query состав серверов и цену их инструментов. */
  private async mcpFromQuery(query: unknown, cwd?: string): Promise<McpSnapshot | undefined> {
    const q = query as {
      mcpServerStatus?: () => Promise<RawMcpStatus[]>
      getContextUsage?: () => Promise<{
        mcpTools?: RawMcpTool[]
        totalTokens?: number
        maxTokens?: number
        categories?: { name?: unknown; tokens?: unknown; isDeferred?: unknown }[]
        memoryFiles?: { path?: unknown; type?: unknown; tokens?: unknown }[]
        skills?: {
          totalSkills?: number
          includedSkills?: number
          tokens?: number
          skillFrontmatter?: { name?: unknown; source?: unknown; tokens?: unknown }[]
        }
      }>
    }
    if (typeof q.mcpServerStatus !== 'function') return undefined
    let raw: RawMcpStatus[]
    try {
      raw = await q.mcpServerStatus()
    } catch {
      return undefined
    }
    // Цена контекста — вторым вопросом и необязательна. Движок постарше её не
    // отдаёт, но это не повод не показать состояние серверов: без цены список
    // всё ещё полезен, а без состояния — бессмыслен.
    let tokensBy: Record<string, number> = {}
    let contextTokens: number | undefined
    let contextMax: number | undefined
    let contextParts: import('@shared/contextParts').ContextPart[] | undefined
    let memoryFiles: import('@shared/types').McpSnapshot['memoryFiles']
    let skills: import('@shared/types').McpSkills | undefined
    if (typeof q.getContextUsage === 'function') {
      try {
        const usage = await q.getContextUsage()
        tokensBy = foldMcpTokens(usage?.mcpTools)
        if (typeof usage?.totalTokens === 'number') contextTokens = usage.totalTokens
        if (typeof usage?.maxTokens === 'number') contextMax = usage.maxTokens
        // Разбор по статьям. Остаток окна и отложенное отделяются здесь же —
        // см. @shared/contextParts: сложить их с занятым значит удвоить цифру.
        const parts = foldContextParts(usage?.categories)
        if (parts.length) contextParts = parts
        // Файлы памяти: чей и почём. `type` движка («User», «Project»,
        // «AutoMem») оставляем как есть — это его слово о происхождении файла.
        const mem = (Array.isArray(usage?.memoryFiles) ? usage.memoryFiles : [])
          .map((f) => ({
            path: typeof f?.path === 'string' ? f.path : '',
            kind: typeof f?.type === 'string' ? f.type : '',
            tokens: typeof f?.tokens === 'number' ? f.tokens : 0
          }))
          .filter((f) => f.path && f.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
        if (mem.length) memoryFiles = mem
        // Скиллы: их описания сидят в контексте всегда, и движок считает это
        // поимённо. Раньше цифра терялась вместе с остальным ответом. Состояние
        // читаем с диска, а не из ответа: движок присылает только то, что
        // ВОШЛО в контекст, — выключенного скилла в списке нет вовсе.
        skills = skillsFrom(usage?.skills, readSkillOverrides(cwd).layers)
      } catch {
        /* цены не будет — состояние покажем всё равно */
      }
    }
    const servers = sortMcpRows(
      (Array.isArray(raw) ? raw : []).map((r) =>
        mcpRowFrom(r, tokensBy[typeof r?.name === 'string' ? r.name : ''])
      )
    )
    return { servers, at: Date.now(), contextTokens, contextMax, contextParts, memoryFiles, skills }
  }

  /** Запомнить снимок, не давая карте расти без предела. */
  private rememberSnapshot(requestId: string, snap: McpSnapshot): void {
    this.mcpSnapshots.set(requestId, snap)
    // Панелей не больше четырёх, но беседы за день накапливаются. Держим
    // последние восемь: снимок беседы, закрытой полдня назад, никому не нужен.
    while (this.mcpSnapshots.size > 8) {
      const oldest = this.mcpSnapshots.keys().next().value
      if (oldest === undefined) break
      this.mcpSnapshots.delete(oldest)
    }
  }

  /** Спросить у одного query его команды и привести их к показываемому виду. */
  private async commandsOf(query: unknown): Promise<import('@shared/agentCommands').AgentCommand[]> {
    try {
      const q = query as { supportedCommands?: () => Promise<unknown> }
      if (typeof q.supportedCommands !== 'function') return []
      return cleanCommands(await q.supportedCommands())
    } catch {
      // Команды недоступны — окно скажет об этом честно, а не покажет пустоту
      // как «команд нет».
      return []
    }
  }

  /**
   * On-demand model catalog for the launch console.
   *
   * Deliberately does NOT trust a live session: the SDK's supportedModels() is
   * `(await this.initialization).models` — a snapshot frozen when that session
   * started, so for anyone mid-conversation it can never surface a model
   * released since, which is exactly the bug this path exists to fix. Always
   * ask a fresh process (cached briefly), and fall back to the session snapshot
   * only if that yields nothing. Renderer keeps its own cache if both fail.
   */
  async listModels(): Promise<import('@shared/types').ClaudeModelInfo[]> {
    const fresh = await this.fetchModelsStandalone()
    if (fresh.length) return fresh
    const entry = this.sessions.entries().next().value
    if (!entry) return []
    try {
      const q = entry[1].query as unknown as {
        supportedModels?: () => Promise<Array<Record<string, unknown>>>
      }
      return mapModelList((await q.supportedModels?.()) ?? [])
    } catch {
      return []
    }
  }

  /**
   * Fetch the model catalog with a throwaway idle query (no live session
   * needed). Guarded so overlapping launch-console opens never spawn a second
   * process; concurrent callers await the same in-flight fetch, and a recent
   * result is reused so repeated opens don't respawn the CLI.
   */
  private modelsStandalonePromise?: Promise<import('@shared/types').ClaudeModelInfo[]>
  private modelsCache?: { at: number; list: import('@shared/types').ClaudeModelInfo[] }
  private fetchModelsStandalone(): Promise<import('@shared/types').ClaudeModelInfo[]> {
    const cached = this.modelsCache
    if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return Promise.resolve(cached.list)
    if (this.modelsStandalonePromise) return this.modelsStandalonePromise
    const run = this.withIdleQuery(async (query) => {
      const q = query as { supportedModels?: () => Promise<Array<Record<string, unknown>>> }
      return mapModelList((await q.supportedModels?.()) ?? [])
    }).then((r) => {
      const list = r ?? []
      // Only a non-empty answer is worth caching — an offline blip must not
      // pin an empty catalog for the next five minutes.
      if (list.length) this.modelsCache = { at: Date.now(), list }
      return list
    })
    this.modelsStandalonePromise = run
    void run.finally(() => {
      this.modelsStandalonePromise = undefined
    })
    return run
  }

  /** Change the model for a live session (streaming input mode). */
  setModel(requestId: string, model: string | undefined): void {
    // Record the flag ONLY when the apply is actually dispatched (live session +
    // method present). If the session is gone or the SDK renamed the method, we
    // don't record — so debugFlags reflects a real apply, not bare intent, and QA
    // catches API drift / dead sessions instead of false-passing. (Synchronous so
    // call order stays deterministic; a later rejection is rare and the model
    // path has a result.models ground-truth backstop.)
    const s = this.sessions.get(requestId)
    if (!s?.query.setModel) return
    s.query.setModel(model || undefined).catch(() => {})
    this.recordFlag(requestId, { model: model || null })
  }

  /** Change reasoning effort on a live session (applyFlagSettings — no dedicated setter). */
  setEffort(requestId: string, effort: string | undefined): void {
    const payload = { effortLevel: effort || null }
    const q = this.sessions.get(requestId)?.query as unknown as {
      applyFlagSettings?: (s: Record<string, unknown>) => Promise<void>
    }
    if (!q?.applyFlagSettings) return
    q.applyFlagSettings(payload).catch(() => {})
    this.recordFlag(requestId, payload)
  }

  /** Toggle ultracode (xhigh + workflow orchestration) on a live session. */
  setUltracode(requestId: string, on: boolean): void {
    const payload = on
      ? { ultracode: true, effortLevel: 'xhigh' }
      : { ultracode: false, effortLevel: null }
    const q = this.sessions.get(requestId)?.query as unknown as {
      applyFlagSettings?: (s: Record<string, unknown>) => Promise<void>
    }
    if (!q?.applyFlagSettings) return
    q.applyFlagSettings(payload).catch(() => {})
    this.recordFlag(requestId, payload)
  }

  /** Generic vendor-flag setter (AgentDriver). Claude's only vendor flag is 'ultracode'. */
  setVendorFlag(requestId: string, key: string, value: unknown): void {
    if (key === 'ultracode') this.setUltracode(requestId, !!value)
    /*
     * «Правки без спроса» переключается ПОСРЕДИ хода — именно тогда в нём и
     * возникает нужда: карточки правок сыплются одна за другой, и человек
     * решает больше их не читать. Ждать следующего сообщения здесь бессмысленно,
     * гейты живут внутри хода.
     *
     * Своего вызова к SDK нет: допуск считается на нашей стороне, в canUseTool,
     * — флаг и ЕСТЬ применённое состояние (как у автопилота).
     */
    if (key === 'editsAuto') {
      const s = this.sessions.get(requestId)
      if (s) s.editsAuto = !!value
      this.recordFlag(requestId, { editsAuto: !!value })
    }
  }

  /**
   * Сменить режим разрешений живой сессии.
   *
   * Нужен режиму плана: движок умеет переключаться на ходу, и заставлять
   * человека начинать новый ход ради этого незачем. Сюда доходят только `plan`
   * и `default` — оба проверены на границе IPC.
   */
  setPermissionMode(requestId: string, mode: 'plan' | 'default'): void {
    const s = this.sessions.get(requestId)
    if (!s) return
    const q = s.query as unknown as { setPermissionMode?: (m: string) => Promise<void> }
    // Молча: движок постарше метода не знает, а следующий ход всё равно уйдёт
    // с нужным режимом в опциях запуска.
    void q.setPermissionMode?.(mode)?.catch?.(() => {})
  }

  /** Toggle bypass ('без спроса') live — flips the canUseTool auto-allow flag. */
  setBypass(requestId: string, bypass: boolean): void {
    // No SDK call (bypass is a renderer-side auto-allow in canUseTool), so record
    // directly — the flag IS the applied state.
    const s = this.sessions.get(requestId)
    if (s) s.bypass = bypass
    this.recordFlag(requestId, { bypass })
  }

  /** Resolve a pending canUseTool decision from a renderer click. */
  resolvePermission(
    requestId: string,
    toolUseId: string,
    decision: ClaudePermissionDecision
  ): void {
    const session = this.sessions.get(requestId)
    const resolve = session?.perms.get(toolUseId)
    if (!resolve) return
    session!.perms.delete(toolUseId)
    resolve(
      decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput }
        : { behavior: 'deny', message: decision.message }
    )
  }

  /**
   * Answer a structured AskUserQuestion (AgentDriver generic path). Maps the
   * driver-agnostic {answers} onto Claude's wire shape ({questions, answers} as
   * the allowed tool's updatedInput), pulling the original questions we stored
   * when the prompt was emitted.
   */
  resolveQuestion(requestId: string, toolUseId: string, answer: AgentQuestionAnswer): void {
    const session = this.sessions.get(requestId)
    const questions = session?.pendingQuestions.get(toolUseId) ?? []
    session?.pendingQuestions.delete(toolUseId)
    this.resolvePermission(requestId, toolUseId, {
      behavior: 'allow',
      updatedInput: { questions, answers: answer.answers }
    })
  }

  /**
   * Отменить ОТПРАВЛЕННОЕ сообщение: прервать ход и запомнить, что следующий
   * начнётся веткой от последнего ответа агента.
   *
   * Просто убрать сообщение из ленты было бы враньём: у агента оно осталось бы в
   * контексте. SDK даёт настоящий механизм — `resumeSessionAt` обрезает историю
   * по UUID ответа, `forkSession` уводит продолжение в новую ветку. Отменённое
   * остаётся в файле мёртвой веткой и в контекст не попадает.
   *
   * Возвращает null, когда отматывать нечем — тогда рендерер обязан оставить
   * сообщение в ленте: убрать с глаз то, что агент помнит, было бы враньём.
   * Разбор случаев — общий для всех драйверов, см. {@link rewindPoint}.
   */
  rewindAfterInterrupt(requestId: string): AgentRewind | null {
    const session = this.sessions.get(requestId)
    if (!session) return null
    const at = rewindPoint({
      lastAssistantUuid: session.lastAssistantUuid,
      sessionId: session.claudeSessionId,
      forkBase: session.forkBase,
      resumed: session.resumed
    })
    if (process.env.ZARYA_DEBUG) {
      console.error(
        '[claude-code] rewind',
        JSON.stringify({
          uuid: session.lastAssistantUuid,
          sid: session.claudeSessionId,
          forkBase: session.forkBase,
          resumed: session.resumed,
          at
        })
      )
    }
    if (!at) return null
    session.rewound = true
    this.interrupt(requestId)
    return at
  }

  interrupt(requestId: string): void {
    const session = this.sessions.get(requestId)
    if (!session) return
    // Interrupt the TURN, not the session. Closing the input queue here ended
    // the whole stream-input, so the child exited and the user's own Esc came
    // back as «Claude Code process exited with code 1» — their cancellation
    // reported as a failure. Codex and the ACP engines already cancel just the
    // turn and keep the session alive; this makes Esc mean the same everywhere.
    // The queue only closes if interrupt() itself is unavailable or fails, in
    // which case aborting is the only way to stop the turn.
    session.interrupted = true
    // Накопленный кусок печати — на выброс: человек прервал ход, и дописать
    // после этого полфразы значило бы показать ответ, которого он не ждёт.
    if (session.deltaTimer) clearTimeout(session.deltaTimer)
    session.deltaTimer = undefined
    session.deltaBuf = undefined
    const q = session.query.interrupt?.()
    if (q) {
      q.catch(() => {
        session.abort.abort()
        session.input.close()
      })
    } else {
      session.abort.abort()
      session.input.close()
    }
  }

  /** List past Claude Code sessions for a folder (for the resume picker). */
  async listSessions(cwd: string | undefined): Promise<ClaudeSessionInfo[]> {
    try {
      const sdk = await loadSdk('@anthropic-ai/claude-agent-sdk')
      const list = await sdk.listSessions(cwd ? { dir: cwd, limit: 40 } : { limit: 40 })
      return list.map((s) => ({
        sessionId: s.sessionId,
        summary: s.customTitle || s.summary || s.firstPrompt || tm('drv.session'),
        lastModified: s.lastModified,
        firstPrompt: s.firstPrompt,
        gitBranch: s.gitBranch
      }))
    } catch {
      return []
    }
  }

  /** Load a past session's messages (mapped to our shape) for display on resume. */
  async loadSessionMessages(sessionId: string, cwd: string | undefined): Promise<AiMessage[]> {
    try {
      const sdk = await loadSdk('@anthropic-ai/claude-agent-sdk')
      const msgs = await sdk.getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined)
      const out: AiMessage[] = []
      for (const sm of msgs as unknown as Array<Record<string, unknown>>) {
        const m = sessionMsgToAiMessage(sm)
        if (m) out.push(m)
      }
      return out
    } catch {
      return []
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.abort.abort()
      session.input.close()
    }
    this.sessions.clear()
    if (this.usageTimer) {
      clearInterval(this.usageTimer)
      this.usageTimer = undefined
    }
  }
}
