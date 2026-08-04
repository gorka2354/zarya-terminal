import { appendFileSync } from 'fs'
import { type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentRewind,
  AgentStreamEvent,
  AgentStartOpts
} from '@shared/types'
import { rewindPoint } from '@shared/rewind'
import type { AgentDriver } from './agentDriver'
import { irreversible } from '@shared/irreversible'

/**
 * A scripted in-process AgentDriver for QA (Ф5). It emits the same
 * {@link AgentStreamEvent}s a real driver would, on a timer so turns "stream",
 * with a CONFIGURABLE {@link AgentCapabilities} profile. This lets the harness
 * prove the whole abstraction (registry routing, per-engine event delivery,
 * capability-gated UI, concurrent turns in one terminal, quit teardown) against
 * engines OTHER than Claude — catching any claude-specific assumption the
 * real-driver paritet tests can't. Registered only when ZARYA_FAKE_AGENT is set.
 */
export class FakeAgentDriver implements AgentDriver {
  readonly engine: AgentEngine
  readonly capabilities: AgentCapabilities
  private getWindow: () => BrowserWindow | null
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private started = new Set<string>()
  /**
   * Состояние «сессии» — ровно то, что нужно отмотке: чем сессия себя назвала,
   * что последним сказал агент и от какой точки эта ветка началась. Живёт между
   * ходами, как у настоящего драйвера (ключ — requestId, он же id беседы).
   */
  /** Запросы, чей инструмент должен работать долго (прогон смотрит на «выполняется»). */
  private slowTools = new Set<string>()
  private sessions = new Map<
    string,
    {
      sessionId: string
      lastAssistantUuid?: string
      forkBase?: { sessionId: string; at: string }
      resumed: boolean
    }
  >()
  private seq = 0

  constructor(
    engine: AgentEngine,
    capabilities: AgentCapabilities,
    getWindow: () => BrowserWindow | null
  ) {
    this.engine = engine
    this.capabilities = capabilities
    this.getWindow = getWindow
  }

  private emit(requestId: string, ev: AgentStreamEvent): void {
    this.getWindow()?.webContents.send(CH.agentStream, requestId, this.engine, ev)
  }

  private schedule(requestId: string, ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms)
    const list = this.timers.get(requestId) ?? []
    list.push(t)
    this.timers.set(requestId, list)
  }

  async start(requestId: string, opts: AgentStartOpts): Promise<void> {
    this.started.add(requestId)
    // Что драйвер получил на входе — для проверки отмотки: тест обязан видеть,
    // с каким resume/resumeAt ушёл СЛЕДУЮЩИЙ ход, иначе «сообщение пропало из
    // контекста» останется словами.
    const log = process.env.ZARYA_FAKE_START_LOG
    if (log) {
      try {
        appendFileSync(
          log,
          JSON.stringify({
            engine: this.engine,
            requestId,
            prompt: opts.prompt,
            resume: opts.resume ?? null,
            resumeAt: opts.resumeAt ?? null
          }) + '\n'
        )
      } catch {
        /* best-effort */
      }
    }
    // Ветка (или первый запуск) — новая сессия со своим id; продолжение живой
    // сессии оставляет прежний.
    const prev = this.sessions.get(requestId)
    const session =
      prev && !opts.resumeAt
        ? prev
        : {
            sessionId: `fake-${this.engine}-${++this.seq}`,
            resumed: !!opts.resume,
            ...(opts.resume && opts.resumeAt
              ? { forkBase: { sessionId: opts.resume, at: opts.resumeAt } }
              : {})
          }
    // Папка беседы: по ней прогон проверяет, что команды и перечитывание
    // приходят от СВОЕЙ панели, а наблюдатель смотрит в её проект.
    this.cwds.set(requestId, opts.cwd ?? '')
    this.sessions.set(requestId, session)
    // init immediately (like a real driver's system:init).
    this.emit(requestId, {
      type: 'init',
      sessionId: session.sessionId,
      model: `${this.engine}-model`,
      cwd: opts.cwd ?? '',
      permissionMode: opts.permissionMode ?? 'default',
      tools: [],
      effort: opts.effort
    })
    if (this.capabilities.usage)
      this.emit(requestId, { type: 'usage', usage: { subscriptionType: 'fake', fiveHourPct: 10 } })
    if (this.capabilities.models)
      this.emit(requestId, {
        type: 'models',
        models: [{ value: `${this.engine}-a`, displayName: `${this.engine} A` }]
      })
    // Stream an assistant reply so the turn takes real wall-clock time. «mute:»
    // — ход, в котором агент НИЧЕГО не говорит: только в таком окне отмена
    // отправленного и имеет смысл, а иначе тест гонялся бы с таймером.
    const mute = /mute/i.test(opts.prompt)
    if (!mute)
      this.schedule(requestId, 250, () => {
        session.lastAssistantUuid = `fake-uuid-${++this.seq}`
        this.emit(requestId, {
          type: 'assistant',
          content: [{ type: 'text', text: `fake ${this.engine}: ${opts.prompt}` }]
        })
      })
    if (mute) {
      this.schedule(requestId, 8000, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    } else if (/skill/i.test(opts.prompt)) {
      // Скилл, взятый агентом. Настоящий движок объявляет это обычным `tool_use`
      // с именем `Skill` и именем скилла в `input.skill` — проверено по записям
      // Claude Code. Прогону это нужно, чтобы увидеть две вещи: что карточка в
      // ленте называет скилл, а не пишет голое «Skill», и что раздел настроек
      // отмечает сработавший.
      this.schedule(requestId, 400, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${requestId}-s1`,
              name: 'Skill',
              input: { skill: 'code-review', args: 'дифф ветки' }
            }
          ]
        })
        this.emit(requestId, {
          type: 'tool_result',
          toolUseId: `${requestId}-s1`,
          content: 'fake: скилл отработал',
          isError: false
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/tool/i.test(opts.prompt)) {
      if (/slow/i.test(opts.prompt)) this.slowTools.add(requestId)
      // Gate a tool so approve/deny + concurrent-gate behaviour is testable.
      // «danger» в запросе — команда, которую нельзя отменить. Нужна прогонам:
      // пол под автопилотом проверяется только настоящим необратимым вызовом.
      const command = /danger/i.test(opts.prompt) ? 'rm -rf build' : 'echo fake'
      const stop = irreversible('Bash', { command })
      // «mcp» в запросе — инструмент стороннего сервера, помеченного им же как
      // разрушающий. Автопилот его не глотает: пометка сервера идёт через тот
      // же пол, что и наше необратимое (см. claudeCodeDriver.canUseTool).
      const viaMcp = /mcp/i.test(opts.prompt)
      // Автопилот здесь ведёт себя как у настоящих движков: обычное проходит
      // молча, необратимое показывается всё равно. Без этого пол нечем
      // проверить — фейковый драйвер спрашивал бы всегда и «прошёл» бы тест,
      // ничего не доказав.
      const viaEdit = /edit/i.test(opts.prompt)
      this.schedule(requestId, 400, () => {
        if (opts.bypass && !stop && !viaMcp) {
          /*
           * Настоящий движок объявляет инструмент блоком `tool_use` в ответе
           * модели — независимо от того, спрашивали разрешение или нет. Раньше
           * фейк при автопилоте слал сразу результат, и в ленте не оставалось
           * НИЧЕГО о том, что агент сделал: прогон не мог проверить показ
           * правки постфактум, а именно так работает человек с автопилотом.
           */
          this.emit(requestId, {
            type: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `${requestId}-t1`,
                name: viaEdit ? 'Edit' : 'Bash',
                input: viaEdit
                  ? {
                      file_path: 'src/shared/fake.ts',
                      old_string: 'const a = 1\nconst b = 2\nkeep me',
                      new_string: 'const a = 42\nkeep me\nconst c = 3'
                    }
                  : { command }
              }
            ]
          })
          this.emit(requestId, {
            type: 'tool_result',
            toolUseId: `${requestId}-t1`,
            content: 'fake: выполнено без подтверждения',
            isError: false
          })
          return
        }
        this.emit(requestId, {
          type: 'permission',
          toolUseId: `${requestId}-t1`,
          toolName: viaEdit ? 'Edit' : viaMcp ? 'mcp__fake_server__wipe' : 'Bash',
          input: viaEdit
            ? {
                file_path: 'src/shared/fake.ts',
                old_string: 'const a = 1\nconst b = 2\nkeep me',
                new_string: 'const a = 42\nkeep me\nconst c = 3'
              }
            : viaMcp
              ? { path: '/tmp/fake' }
              : { command },
          irreversible: stop ?? undefined,
          mcpMark: viaMcp ? { destructive: true } : undefined
        })
      })
    } else if (/ask/i.test(opts.prompt) && this.capabilities.structuredQuestions) {
      // Structured AskUserQuestion (only if the driver declares the capability).
      this.schedule(requestId, 400, () =>
        this.emit(requestId, {
          type: 'permission',
          toolUseId: `${requestId}-q1`,
          toolName: 'AskUserQuestion',
          input: {},
          questions: [
            {
              question: 'Цвет?',
              header: 'Тема',
              options: [{ label: 'Красный' }, { label: 'Синий' }]
            }
          ]
        })
      )
    } else if (/slow/i.test(opts.prompt)) {
      // Долгий ход без гейта — чтобы успеть проверить то, что делается ПОКА
      // агент работает: очередь, Esc, прерывание. На 500мс такие сценарии
      // превращаются в гонку с самим тестом.
      this.schedule(requestId, 8000, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    } else {
      this.schedule(requestId, 500, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    }
  }

  input(requestId: string, text: string): void {
    this.schedule(requestId, 150, () =>
      this.emit(requestId, {
        type: 'assistant',
        content: [{ type: 'text', text: `fake ${this.engine} f/u: ${text}` }]
      })
    )
    this.schedule(requestId, 300, () =>
      this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
    )
  }

  interrupt(requestId: string): void {
    this.emit(requestId, { type: 'result', isError: false })
  }

  /**
   * Отмотка — только если профиль движка её заявляет: так харнесс проверяет ОБА
   * поведения. Правило то же, что у настоящего драйвера: есть ответ агента —
   * ветка от него; нет, но ветка сама откуда-то началась — от той же точки;
   * продолженная сессия без ответа — отматывать нечем, честный отказ.
   */
  rewindAfterInterrupt(requestId: string): AgentRewind | null {
    if (!this.capabilities.rewind) return null
    const s = this.sessions.get(requestId)
    if (!s) return null
    const at = rewindPoint(s)
    if (!at) return null
    if (at.kind === 'fresh') this.sessions.delete(requestId)
    this.interrupt(requestId)
    return at
  }

  resolvePermission(requestId: string, toolUseId: string, decision: AgentPermissionDecision): void {
    // «slow» в запросе — инструмент, который ДОЛГО работает. Настоящая команда
    // агента (клонирование, установка пакетов) идёт секунды и минуты, и всё,
    // что показывает лента в это время, проверить на мгновенном ответе нельзя:
    // карточка исчезает раньше, чем прогон успевает на неё посмотреть.
    const slow = decision.behavior === 'allow' && this.slowTools.has(requestId)
    const emitResult = (): void => {
      this.emit(requestId, {
        type: 'tool_result',
        toolUseId,
        content: decision.behavior === 'allow' ? 'fake tool output' : decision.message,
        isError: decision.behavior === 'deny'
      })
      this.schedule(requestId, 120, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    }
    if (slow) this.schedule(requestId, 6000, emitResult)
    else emitResult()
  }

  resolveQuestion(requestId: string, toolUseId: string, answer: AgentQuestionAnswer): void {
    this.emit(requestId, {
      type: 'tool_result',
      toolUseId,
      content: `answered: ${Object.values(answer.answers).flat().join(', ')}`,
      isError: false
    })
    this.schedule(requestId, 120, () =>
      this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
    )
  }

  async listSessions(): Promise<[]> {
    return []
  }
  async listModels(): Promise<{ value: string; displayName: string }[]> {
    return [{ value: `${this.engine}-a`, displayName: `${this.engine} A` }]
  }
  setModel(): void {}
  setEffort(): void {}
  setBypass(): void {}
  setVendorFlag(): void {}

  /** Папка каждой беседы — источник ответов sessionCwd/listCommands. */
  private cwds = new Map<string, string>()

  sessionCwd(requestId: string): string | undefined {
    return this.cwds.get(requestId)
  }

  /**
   * Команды ЭТОЙ беседы.
   *
   * Одна общая — «/fake-common», и одна именная по папке — «/proj-<папка>».
   * Именно вторая доказывает маршрутизацию: две панели в разных проектах
   * обязаны получить разные списки, а не один от случайной сессии.
   */
  async listCommands(
    requestId?: string
  ): Promise<import('@shared/agentCommands').AgentCommand[]> {
    const cwd = requestId ? this.cwds.get(requestId) : undefined
    const leaf = (cwd ?? '').split(/[\\/]/).filter(Boolean).pop()
    return [
      { name: 'fake-common', description: 'команда, общая для всех панелей' },
      ...(leaf ? [{ name: `proj-${leaf}`, description: `команда проекта ${leaf}` }] : [])
    ]
  }

  /** Перечитать «диск» ЭТОЙ беседы — в ответе видно, чью именно. */
  async reloadExtras(requestId?: string): Promise<import('@shared/types').AgentExtrasReload> {
    if (!requestId || !this.started.has(requestId))
      return { ok: false, commands: [], plugins: 0, mcpServers: [], errors: 0 }
    return {
      ok: true,
      commands: await this.listCommands(requestId),
      plugins: 0,
      mcpServers: [{ name: `mcp-of-${this.cwds.get(requestId)?.split(/[\\/]/).pop() ?? '?'}` }],
      errors: 0
    }
  }

  /**
   * Состав инструментов — разыгранный, но со всеми состояниями сразу.
   *
   * Здесь нарочно есть каждое: упавший сервер с причиной, ждущий логина,
   * работающий с ценой в токенах и выключенный. Прогон должен видеть все
   * четыре строки, потому что в жизни человек видит именно такую смесь (на
   * машине владельца из четырнадцати серверов три упали и пять ждут логина).
   *
   * Возможность объявляется через `capabilities.mcp`: у движка без неё этих
   * методов нет вовсе, и окно скажет «не умеет» вместо пустого списка.
   */
  private mcpDisabled = new Set<string>()
  private skillStates = new Map<string, import('@shared/types').SkillState>()

  async mcpStatus(
    requestId: string | undefined,
    opts?: { probe?: boolean }
  ): Promise<import('@shared/types').McpSnapshot> {
    if (!this.capabilities.mcp) return { unsupported: true, servers: [] }
    // Живой беседы нет: без нажатия — прошлый снимок (у фейка его нет, значит
    // пусто с пометкой), с нажатием — «проверили».
    const live = !!requestId && this.started.has(requestId)
    if (!live && !opts?.probe) return { servers: [], stale: true }
    const off = (name: string): boolean => this.mcpDisabled.has(name)
    const sk = (
      name: string,
      source: string,
      tokens: number,
      extra?: Partial<import('@shared/types').SkillRow>
    ): import('@shared/types').SkillRow => ({
      name,
      source,
      tokens,
      state: this.skillStates.get(name) ?? 'on',
      ...extra
    })
    return {
      at: Date.now(),
      contextTokens: 42_000,
      contextMax: 200_000,
      // Разыгранные скиллы покрывают все случаи, из-за которых строка ведёт
      // себя по-разному: дорогой личный, встроенный, плагинный (его
      // `skillOverrides` не берёт), перекрытый настройкой проекта и уже
      // выключенный — тот, которого в контексте нет и цена которого неизвестна.
      skills: {
        total: 5,
        included: 4,
        tokens: 1_190,
        items: [
          sk('code-review', 'userSettings', 620),
          sk('dataviz', 'built-in', 380),
          sk('cloudflare:email-service', 'plugin', 190),
          sk('team-deploy', 'projectSettings', 0, { state: 'name-only', from: 'project' }),
          sk('legacy-context', '', 0, { state: 'off', from: 'user' })
        ]
      },
      servers: [
        {
          name: 'broken-one',
          status: off('broken-one') ? 'disabled' : 'failed',
          error: 'MCP endpoint not found at https://example.invalid',
          transport: 'http',
          origin: 'example.invalid',
          scope: 'user'
        },
        {
          name: 'needs-login',
          status: off('needs-login') ? 'disabled' : 'needs-auth',
          transport: 'http',
          origin: 'login.example.com',
          scope: 'user'
        },
        {
          name: 'working-one',
          status: off('working-one') ? 'disabled' : 'connected',
          transport: 'stdio',
          origin: 'npx',
          scope: 'project',
          version: '1.2.3',
          tools: 12,
          tokens: 8_400
        },
        {
          name: 'switched-off',
          status: 'disabled',
          transport: 'stdio',
          origin: 'uvx',
          scope: 'local'
        }
      ]
    }
  }

  async mcpReconnect(
    requestId: string,
    name: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    if (!this.capabilities.mcp) return { ok: false, reason: 'unsupported' }
    if (!this.started.has(requestId)) return { ok: false, reason: 'no-session' }
    // Сломанный остаётся сломанным: кнопка, которая «чинит» одним нажатием всё,
    // научила бы человека верить ей и там, где чинить нечего.
    if (name === 'broken-one') return { ok: false, error: 'connection refused' }
    return { ok: true }
  }

  async mcpToggle(
    requestId: string,
    name: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    if (!this.capabilities.mcp) return { ok: false, reason: 'unsupported' }
    if (!this.started.has(requestId)) return { ok: false, reason: 'no-session' }
    if (enabled) this.mcpDisabled.delete(name)
    else this.mcpDisabled.add(name)
    return { ok: true }
  }

  /**
   * Состояние скилла — в памяти прогона.
   *
   * Настоящий драйвер пишет в `~/.claude/settings.json`; фейку это запрещено:
   * прогон не имеет права трогать настройки человека, а на машине QA их может
   * не быть вовсе. Отказ на перекрытом ключе разыгран, потому что именно он
   * решает, показывать ли переключатель.
   */
  async skillOverride(
    _requestId: string | undefined,
    name: string,
    state: import('@shared/types').SkillState
  ): Promise<{
    ok: boolean
    error?: string
    reason?: 'overridden'
    by?: import('@shared/types').SkillLayer
  }> {
    if (name === 'team-deploy') return { ok: false, reason: 'overridden', by: 'project' }
    if (name === 'cloudflare:email-service') return { ok: false, error: 'скилл плагина' }
    this.skillStates.set(name, state)
    return { ok: true }
  }

  killAll(): void {
    this.timers.forEach((ts) => ts.forEach(clearTimeout))
    this.timers.clear()
    this.started.clear()
    // QA teardown assert: prove the registry called killAll on quit for EVERY
    // driver (a leaked real subprocess would be the production bug this catches).
    const log = process.env.ZARYA_FAKE_KILL_LOG
    if (log) {
      try {
        appendFileSync(log, this.engine + '\n')
      } catch {
        /* best-effort */
      }
    }
  }
}
