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
        this.emit(requestId, { type: 'result', isError: false, models: [`${this.engine}-model`] })
      )
    } else if (/tool/i.test(opts.prompt)) {
      if (/slow/i.test(opts.prompt)) this.slowTools.add(requestId)
      // Gate a tool so approve/deny + concurrent-gate behaviour is testable.
      // «danger» в запросе — команда, которую нельзя отменить. Нужна прогонам:
      // пол под автопилотом проверяется только настоящим необратимым вызовом.
      const command = /danger/i.test(opts.prompt) ? 'rm -rf build' : 'echo fake'
      const stop = irreversible('Bash', { command })
      // Автопилот здесь ведёт себя как у настоящих движков: обычное проходит
      // молча, необратимое показывается всё равно. Без этого пол нечем
      // проверить — фейковый драйвер спрашивал бы всегда и «прошёл» бы тест,
      // ничего не доказав.
      this.schedule(requestId, 400, () => {
        if (opts.bypass && !stop) {
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
          toolName: 'Bash',
          input: { command },
          irreversible: stop ?? undefined
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
        this.emit(requestId, { type: 'result', isError: false, models: [`${this.engine}-model`] })
      )
    } else {
      this.schedule(requestId, 500, () =>
        this.emit(requestId, { type: 'result', isError: false, models: [`${this.engine}-model`] })
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
      this.emit(requestId, { type: 'result', isError: false, models: [`${this.engine}-model`] })
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
        this.emit(requestId, { type: 'result', isError: false, models: [`${this.engine}-model`] })
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
      this.emit(requestId, { type: 'result', isError: false, models: [`${this.engine}-model`] })
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
