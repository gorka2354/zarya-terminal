import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { CH } from '@shared/ipc'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentQuestionAnswer,
  AiContentPart,
  AiMessage,
  ClaudeCliQuestion,
  ClaudePermissionDecision,
  ClaudeSessionInfo,
  ClaudeStartOpts,
  ClaudeStreamEvent
} from '@shared/types'
import type { AgentDriver } from './agentDriver'
// Types only (erased at runtime) — safe to import statically from the ESM-only
// package; the runtime value is loaded via a dynamic import below.
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
 * When packaged, the SDK resolves its bundled native binary to a path INSIDE
 * app.asar (which the OS can't exec — "exists but failed to launch"). The
 * binary is asar-unpacked, so point the SDK at the real on-disk copy. In dev
 * (unpacked) the SDK auto-resolves correctly, so return undefined.
 */
function packagedClaudeExe(): string | undefined {
  if (!app.isPackaged) return undefined
  const pkg =
    process.platform === 'win32'
      ? 'claude-agent-sdk-win32-x64'
      : process.platform === 'darwin'
        ? `claude-agent-sdk-darwin-${process.arch}`
        : `claude-agent-sdk-linux-${process.arch}`
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const p = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    pkg,
    exe
  )
  return existsSync(p) ? p : undefined
}

/** An async message queue feeding query()'s streaming-input iterable. */
function createInputQueue(): {
  push: (m: SDKUserMessage) => void
  close: () => void
  iterable: AsyncIterable<SDKUserMessage>
} {
  const buffer: SDKUserMessage[] = []
  let pending: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  let closed = false
  return {
    push(m) {
      if (pending) {
        pending({ value: m, done: false })
        pending = null
      } else buffer.push(m)
    },
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

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null
  } as SDKUserMessage
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
    // thinking / other blocks are intentionally not surfaced (yet)
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
    if (content.trim() && !content.startsWith('[Контекст:')) parts.push({ type: 'text', text: content })
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
  /** toolUseID -> resolver for a canUseTool call awaiting the user's decision. */
  perms: Map<string, (r: PermissionResult | null) => void>
  /** toolUseID -> the AskUserQuestion questions, so resolveQuestion rebuilds the answer envelope. */
  pendingQuestions: Map<string, ClaudeCliQuestion[]>
  /** Bypass ('без спроса'): auto-approve ordinary tools in canUseTool (live-toggleable). */
  bypass: boolean
  /** Effort override for this session, so init reports the effective value. */
  effort?: string
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
    vendorFlags: [{ key: 'ultracode', label: 'ULTRACODE', desc: 'xhigh + оркестрация воркфлоу' }]
  }
  private sessions = new Map<string, Session>()
  private getWindow: () => BrowserWindow | null
  private usageTimer?: ReturnType<typeof setInterval>
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
    // Generic agent stream — carries `engine` so the renderer routes without a
    // per-vendor channel. The claudeCode.* preload shim filters to this engine.
    this.getWindow()?.webContents.send(CH.agentStream, requestId, this.engine, ev)
  }

  async start(requestId: string, opts: ClaudeStartOpts): Promise<void> {
    // A follow-up turn on an existing live session just enqueues the message.
    const existing = this.sessions.get(requestId)
    if (existing) {
      // Re-sync the per-session bypass to the current global (dispatchClaude
      // passes the live setting every turn) so a background session can't keep a
      // stale bypass flag that contradicts what the chip shows.
      existing.bypass = !!opts.bypass
      existing.input.push(userMessage(opts.prompt))
      return
    }

    let sdk: typeof import('@anthropic-ai/claude-agent-sdk')
    try {
      sdk = await loadSdk('@anthropic-ai/claude-agent-sdk')
    } catch (e) {
      this.emit(requestId, {
        type: 'error',
        message: `Не удалось загрузить Claude Agent SDK: ${e instanceof Error ? e.message : String(e)}`
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
        if (!isQuestion && this.sessions.get(requestId)?.bypass) {
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
          questions: isQuestion ? extractQuestions(toolInput) : undefined
        })
        ctx.signal.addEventListener('abort', () => {
          if (perms.delete(ctx.toolUseID)) resolve({ behavior: 'deny', message: 'Прервано' })
        })
      })

    const claudeExe = packagedClaudeExe()
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
      includePartialMessages: false,
      stderr: (data) => {
        // The bundled CLI writes interactive-picker keybinding hints and other TUI
        // chatter to stderr even in headless mode — pure noise in a GUI. Keep it
        // out of the console by default; real failures already surface as 'error'
        // events. Opt in with ZARYA_DEBUG=1 when debugging the subprocess.
        if (process.env.ZARYA_DEBUG) console.error('[claude-code]', data.trim())
      },
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort as Options['effort'] } : {}),
      // Ultracode is a flag-settings toggle (xhigh + workflow orchestration).
      ...(opts.ultracode
        ? { settings: { ultracode: true, effortLevel: 'xhigh' } as Options['settings'] }
        : {}),
      ...(opts.resume ? { resume: opts.resume } : {})
    }
    // Remember the effort override so init reports the effective value.
    const effortOverride = opts.effort

    input.push(userMessage(opts.prompt))
    let query: Query
    try {
      query = sdk.query({ prompt: input.iterable, options })
    } catch (e) {
      this.emit(requestId, {
        type: 'error',
        message: `Claude Code не запустился: ${e instanceof Error ? e.message : String(e)}`
      })
      return
    }

    const session: Session = {
      query,
      input,
      abort,
      perms,
      pendingQuestions,
      bypass: !!opts.bypass,
      effort: effortOverride
    }
    this.sessions.set(requestId, session)

    void this.pump(requestId, session)
  }

  /** Drain the query's message stream, translating each into a ClaudeStreamEvent. */
  private async pump(requestId: string, session: Session): Promise<void> {
    try {
      for await (const msg of session.query as AsyncIterable<SDKMessage>) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              this.emit(requestId, {
                type: 'init',
                sessionId: msg.session_id,
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

          case 'rate_limit_event': {
            const info = (msg as { rate_limit_info?: { utilization?: number; resetsAt?: number; rateLimitType?: string } })
              .rate_limit_info
            if (info?.utilization !== undefined) {
              const isWeekly = (info.rateLimitType ?? '').startsWith('seven_day')
              this.emit(requestId, {
                type: 'usage',
                usage: isWeekly
                  ? { sevenDayPct: info.utilization * 100, sevenDayResetsAt: info.resetsAt }
                  : { fiveHourPct: info.utilization * 100, fiveHourResetsAt: info.resetsAt }
              })
            }
            break
          }

          case 'assistant': {
            const content = mapAssistantContent(
              (msg.message as { content?: unknown }).content
            )
            if (content.length) this.emit(requestId, { type: 'assistant', content })
            break
          }

          case 'user': {
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

          case 'result':
            this.emit(requestId, {
              type: 'result',
              isError: msg.is_error,
              result: 'result' in msg ? msg.result : undefined,
              costUsd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
              numTurns: 'num_turns' in msg ? msg.num_turns : undefined,
              sessionId: msg.session_id,
              models: Object.keys(
                (msg as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}
              )
            })
            // Refresh the subscription usage gauge after each completed turn.
            void this.fetchUsage(requestId, session)
            break

          default:
            // partial-assistant / status / hook / task / etc. — ignored for now
            break
        }
      }
    } catch (e) {
      if (!session.abort.signal.aborted) {
        this.emit(requestId, {
          type: 'error',
          message: e instanceof Error ? e.message : String(e)
        })
      }
    } finally {
      this.sessions.delete(requestId)
      // Fail any still-pending permission prompts so the SDK isn't left hanging.
      for (const resolve of session.perms.values()) resolve(null)
      session.perms.clear()
    }
  }

  /** Pull the /usage snapshot (subscription rate-limit windows) after a turn. */
  private async fetchUsage(requestId: string, session: Session): Promise<void> {
    try {
      const q = session.query as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
      }
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof fn !== 'function') return
      const resp = await fn.call(session.query)
      const usage = usageFromResponse(resp)
      if (usage.fiveHourPct !== undefined || usage.sevenDayPct !== undefined || usage.subscriptionType) {
        this.emit(requestId, { type: 'usage', usage })
      }
    } catch {
      // Experimental API — best-effort, ignore failures.
    }
  }

  /** Enqueue a follow-up user turn on an existing session. */
  input(requestId: string, text: string): void {
    this.sessions.get(requestId)?.input.push(userMessage(text))
  }

  /** Fetch the dynamic model catalog from a live session and emit it. */
  private async fetchModels(requestId: string, session: Session): Promise<void> {
    try {
      const q = session.query as unknown as {
        supportedModels?: () => Promise<Array<Record<string, unknown>>>
      }
      const list = (await q.supportedModels?.()) ?? []
      const models = list.map((m) => ({
        value: String(m.value ?? ''),
        resolvedModel: typeof m.resolvedModel === 'string' ? m.resolvedModel : undefined,
        displayName: String(m.displayName ?? m.value ?? ''),
        description: typeof m.description === 'string' ? m.description : undefined,
        supportsEffort: typeof m.supportsEffort === 'boolean' ? m.supportsEffort : undefined,
        supportedEffortLevels: Array.isArray(m.supportedEffortLevels)
          ? (m.supportedEffortLevels as import('@shared/types').ClaudeEffortLevel[])
          : undefined
      }))
      if (models.length) this.emit(requestId, { type: 'models', models })
    } catch {
      // supported-models unavailable — the renderer keeps its fallback list.
    }
  }

  /** On-demand model catalog (any live session; renderer falls back to cache). */
  async listModels(): Promise<import('@shared/types').ClaudeModelInfo[]> {
    const entry = this.sessions.entries().next().value
    if (!entry) return []
    try {
      const q = entry[1].query as unknown as {
        supportedModels?: () => Promise<Array<Record<string, unknown>>>
      }
      const list = (await q.supportedModels?.()) ?? []
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
    } catch {
      return []
    }
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

  interrupt(requestId: string): void {
    const session = this.sessions.get(requestId)
    if (!session) return
    session.query.interrupt?.().catch(() => session.abort.abort())
    session.input.close()
  }

  /** List past Claude Code sessions for a folder (for the resume picker). */
  async listSessions(cwd: string | undefined): Promise<ClaudeSessionInfo[]> {
    try {
      const sdk = await loadSdk('@anthropic-ai/claude-agent-sdk')
      const list = await sdk.listSessions(cwd ? { dir: cwd, limit: 40 } : { limit: 40 })
      return list.map((s) => ({
        sessionId: s.sessionId,
        summary: s.customTitle || s.summary || s.firstPrompt || 'Сессия',
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
