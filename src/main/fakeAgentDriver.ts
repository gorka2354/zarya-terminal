import { appendFileSync } from 'fs'
import { type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentStreamEvent,
  AgentStartOpts
} from '@shared/types'
import type { AgentDriver } from './agentDriver'

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
    // init immediately (like a real driver's system:init).
    this.emit(requestId, {
      type: 'init',
      sessionId: `fake-${this.engine}-${requestId}`,
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
    // Stream an assistant reply so the turn takes real wall-clock time.
    this.schedule(requestId, 250, () =>
      this.emit(requestId, {
        type: 'assistant',
        content: [{ type: 'text', text: `fake ${this.engine}: ${opts.prompt}` }]
      })
    )
    if (/tool/i.test(opts.prompt)) {
      // Gate a tool so approve/deny + concurrent-gate behaviour is testable.
      this.schedule(requestId, 400, () =>
        this.emit(requestId, {
          type: 'permission',
          toolUseId: `${requestId}-t1`,
          toolName: 'Bash',
          input: { command: 'echo fake' }
        })
      )
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

  resolvePermission(requestId: string, toolUseId: string, decision: AgentPermissionDecision): void {
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
