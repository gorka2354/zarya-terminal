import { spawn, type ChildProcess } from 'child_process'
import { type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentModelInfo,
  AgentPermissionDecision,
  AgentStartOpts,
  AgentStreamEvent
} from '@shared/types'
import type { AgentDriver } from './agentDriver'
import { JsonlDecoder, classifyCodexMessage, type CodexInbound } from './codexRpc'
import {
  CODEX_APPROVAL,
  CODEX_CLIENT_NOTIFY,
  CODEX_METHOD,
  CODEX_NOTIFY,
  codexEffort,
  codexModel,
  type CodexCommandApprovalParams,
  type CodexFileChangeApprovalParams,
  type CodexItemNotification,
  type CodexThreadStartResponse,
  type CodexTurnNotification,
  type CodexTurnStartResponse
} from './codexProtocol'

/** codex binary + args, overridable for tests (point at the mock app-server). */
const CODEX_BIN = process.env.ZARYA_CODEX_BIN || 'codex'
/** A request with no matching response by this deadline rejects, so a hung or
 *  silent app-server surfaces an error instead of an eternal spinner. */
const REQUEST_TIMEOUT_MS = 120_000
function codexArgs(): string[] {
  const raw = process.env.ZARYA_CODEX_ARGS
  if (!raw) return ['app-server']
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.map(String) : ['app-server']
  } catch {
    return ['app-server']
  }
}

/** Fallback catalog if a live `model/list` call fails (offline / old codex). */
const CODEX_STATIC_MODELS: AgentModelInfo[] = [
  { value: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', supportsEffort: true },
  { value: 'gpt-5.1', displayName: 'GPT-5.1', supportsEffort: true }
]

/** Per-conversation state; one Codex thread multiplexed over the shared server. */
interface CodexSession {
  threadId?: string
  turnId?: string
  /** toolUseId (== approval itemId) -> the JSON-RPC request id we must reply to. */
  approvals: Map<string, number | string>
  model?: string
  effort?: string
  bypass?: boolean
  cwd?: string
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/ENOENT|not found|не найден/i.test(msg))
    return 'Codex CLI не найден. Установи: `npm i -g @openai/codex`, затем `codex login`.'
  if (/auth|login|unauthor/i.test(msg))
    return 'Codex не авторизован. Выполни `codex login` в терминале и повтори.'
  return `Codex: ${msg}`
}

/**
 * Native Codex driver over `codex app-server` (JSON-RPC/JSONL on stdio). ONE
 * long-lived child multiplexes every conversation by an internal thread id the
 * driver maps from `requestId` (== conversation id). Tool approvals arrive as
 * server-initiated requests and surface to the renderer as `permission` events,
 * resolved by a UI click — symmetric to Claude's canUseTool. See inc-10 plan.
 */
export class CodexDriver implements AgentDriver {
  readonly engine: AgentEngine = 'codex'
  readonly capabilities: AgentCapabilities = {
    models: true,
    modelsWithoutSession: true, // Codex model ids are known without a live session
    effort: true,
    bypass: true, // approvalPolicy:'never'
    resumableSessions: true,
    usage: false, // token counts exist, but no subscription fuel gauge
    structuredQuestions: false // approvals are gates, not AskUserQuestion
  }

  private getWindow: () => BrowserWindow | null
  private proc?: ChildProcess
  private decoder = new JsonlDecoder()
  private nextId = 1
  // Keyed by String(id): a spec-compliant server echoes our numeric id, but a
  // server that stringifies it must still match — never a silent miss that hangs.
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private sessions = new Map<string, CodexSession>()
  /** threadId -> requestId, so a notification routes to the right conversation. */
  private threadToRequest = new Map<string, string>()
  private ready?: Promise<void>
  /** Tail of the app-server's stderr, surfaced in errors (e.g. auth failures). */
  private lastStderr = ''

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow
  }

  private emit(requestId: string, ev: AgentStreamEvent): void {
    this.getWindow()?.webContents.send(CH.agentStream, requestId, this.engine, ev)
  }

  // --- transport ---------------------------------------------------------

  private write(msg: unknown): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const key = String(id)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(key)) reject(new Error(`codex: нет ответа на ${method} (таймаут)`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(key, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.write({ id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  /** Spawn the app-server + JSON-RPC handshake, once. Rejects on spawn/handshake failure. */
  private ensureServer(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawn(CODEX_BIN, codexArgs(), { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        this.ready = undefined
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      this.proc = proc
      proc.on('error', (e) => {
        if (this.proc !== proc) return // stale handler from a replaced process
        this.ready = undefined
        reject(e)
      })
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => this.onData(chunk))
      // Drain stderr (keep only a small tail for diagnostics) — an unread stderr
      // pipe would fill the OS buffer and block the codex process on write.
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (d: string) => {
        this.lastStderr = (this.lastStderr + d).slice(-2000)
      })
      proc.on('exit', () => {
        if (this.proc !== proc) return // stale: killAll already replaced/cleared it
        const tail = this.lastStderr.trim()
        const err = new Error(tail ? `codex app-server завершился: ${tail}` : 'codex app-server завершился')
        for (const w of this.pending.values()) w.reject(err)
        this.pending.clear()
        // The turns in flight stream via notifications, not pending requests, so
        // reject alone leaves them spinning forever and their sessions carry a
        // now-dead threadId. Tell every live conversation and drop the sessions
        // so the next turn re-opens a fresh thread on a respawned server.
        const msg = friendlyError(err)
        for (const requestId of this.sessions.keys()) this.emit(requestId, { type: 'error', message: msg })
        this.sessions.clear()
        this.threadToRequest.clear()
        this.proc = undefined
        this.ready = undefined
      })
      // Handshake: initialize -> (response) -> `initialized` notification.
      this.request(CODEX_METHOD.initialize, {
        clientInfo: { name: 'zarya', title: 'Zarya', version: '0.4.0' },
        capabilities: { experimentalApi: false }
      })
        .then(() => {
          this.notify(CODEX_CLIENT_NOTIFY.initialized, {})
          resolve()
        })
        .catch((e) => {
          // A wedged/erroring handshake must not leave `ready` a rejected promise
          // with an orphan child — that permanently wedges the engine. Reset so
          // the next start() respawns.
          if (this.proc === proc) {
            try {
              proc.kill()
            } catch {
              /* ignore */
            }
            this.proc = undefined
          }
          this.ready = undefined
          reject(e)
        })
    })
    return this.ready
  }

  private onData(chunk: string): void {
    for (const msg of this.decoder.push(chunk)) {
      const c = classifyCodexMessage(msg)
      if (c) this.handleInbound(c)
    }
  }

  private handleInbound(c: CodexInbound): void {
    if (c.kind === 'response') {
      const key = String(c.id)
      const waiter = this.pending.get(key)
      if (!waiter) return
      this.pending.delete(key)
      if (c.error) waiter.reject(new Error(c.error.message))
      else waiter.resolve(c.result)
      return
    }
    if (c.kind === 'serverRequest') {
      this.handleServerRequest(c)
      return
    }
    this.handleNotification(c.method, c.params)
  }

  // --- notification -> AgentStreamEvent ----------------------------------

  private routeThread(threadId?: string): string | undefined {
    return threadId ? this.threadToRequest.get(threadId) : undefined
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as { threadId?: string } | undefined
    const requestId = this.routeThread(p?.threadId)
    if (!requestId) return

    switch (method) {
      case CODEX_NOTIFY.itemCompleted: {
        const item = (params as CodexItemNotification).item
        if (item?.type === 'agentMessage') {
          // Coerce: codex-supplied fields are untrusted; force a string so a
          // misbehaving server can't inject a non-string into the renderer.
          const text = String((item as { text?: unknown }).text ?? '')
          this.emit(requestId, { type: 'assistant', content: [{ type: 'text', text }] })
        } else if (item?.type === 'commandExecution') {
          const ce = item as { id: string; aggregatedOutput?: unknown; exitCode?: number | null }
          this.emit(requestId, {
            type: 'tool_result',
            toolUseId: String(ce.id),
            content: ce.aggregatedOutput == null ? '' : String(ce.aggregatedOutput),
            isError: ce.exitCode != null && ce.exitCode !== 0
          })
        }
        break
      }
      case CODEX_NOTIFY.turnCompleted: {
        const turn = (params as CodexTurnNotification).turn
        const failed = turn?.status === 'failed'
        if (failed)
          this.emit(requestId, { type: 'error', message: turn?.error?.message ?? 'Ход завершился ошибкой' })
        const model = this.sessions.get(requestId)?.model
        this.emit(requestId, {
          type: 'result',
          isError: !!failed,
          result: turn?.error?.message,
          models: model ? [model] : undefined
        })
        break
      }
      // turn/started, item/started, item/agentMessage/delta, tokenUsage:
      // not surfaced in the Ф2 MVP (assistant is emitted whole on item/completed).
    }
  }

  /**
   * Approval gates (server -> client requests) for a `turn/start` turn. Maps
   * item/commandExecution/requestApproval + item/fileChange/requestApproval onto
   * a `permission` event (the UI's approve/deny), remembering the JSON-RPC id so
   * resolvePermission() can reply {decision} to the exact request. A gate we
   * can't route (unknown thread / unknown method) is declined so the turn never
   * hangs waiting on us.
   */
  private handleServerRequest(c: Extract<CodexInbound, { kind: 'serverRequest' }>): void {
    const params = c.params as (CodexCommandApprovalParams | CodexFileChangeApprovalParams) | undefined
    const requestId = this.routeThread(params?.threadId)
    const session = requestId ? this.sessions.get(requestId) : undefined
    if (!requestId || !session || !params?.itemId) {
      this.respond(c.id, { decision: 'decline' })
      return
    }
    const toolUseId = String(params.itemId)
    // A second approval reusing an in-flight itemId would overwrite the stored
    // reply id and strand the first request — decline the duplicate instead.
    if (session.approvals.has(toolUseId)) {
      this.respond(c.id, { decision: 'decline' })
      return
    }
    session.approvals.set(toolUseId, c.id)
    if (c.method === CODEX_APPROVAL.command) {
      const p = params as CodexCommandApprovalParams
      const command = p.command == null ? '' : String(p.command)
      const cwd = p.cwd == null ? '' : String(p.cwd)
      this.emit(requestId, {
        type: 'permission',
        toolUseId,
        toolName: 'Bash',
        input: { command, cwd },
        displayName: command || 'Команда'
      })
    } else if (c.method === CODEX_APPROVAL.fileChange) {
      const p = params as CodexFileChangeApprovalParams
      this.emit(requestId, {
        type: 'permission',
        toolUseId,
        toolName: 'ApplyPatch',
        input: { reason: p.reason == null ? null : String(p.reason) },
        displayName: 'Изменение файлов'
      })
    } else {
      // Unknown server request — decline and forget so nothing strands.
      session.approvals.delete(toolUseId)
      this.respond(c.id, { decision: 'decline' })
    }
  }

  // --- AgentDriver surface ----------------------------------------------

  async start(requestId: string, opts: AgentStartOpts): Promise<void> {
    try {
      await this.ensureServer()
    } catch (e) {
      this.emit(requestId, { type: 'error', message: friendlyError(e) })
      return
    }

    let session = this.sessions.get(requestId)
    if (!session) {
      session = {
        approvals: new Map(),
        model: codexModel(opts.model),
        effort: codexEffort(opts.effort),
        bypass: opts.bypass,
        cwd: opts.cwd
      }
      this.sessions.set(requestId, session)
      const approvalPolicy = opts.bypass ? 'never' : 'on-request'
      const method = opts.resume ? CODEX_METHOD.threadResume : CODEX_METHOD.threadStart
      const params = opts.resume
        ? { threadId: opts.resume, cwd: opts.cwd, model: session.model, approvalPolicy }
        : {
            cwd: opts.cwd,
            model: session.model,
            sandbox: 'workspaceWrite',
            approvalPolicy,
            ...(session.effort ? { config: { model_reasoning_effort: session.effort } } : {})
          }
      let res: CodexThreadStartResponse
      try {
        res = (await this.request(method, params)) as CodexThreadStartResponse
      } catch (e) {
        this.sessions.delete(requestId)
        this.emit(requestId, { type: 'error', message: friendlyError(e) })
        return
      }
      const threadId = res?.thread?.id
      if (!threadId) {
        // No usable thread → drop the session (symmetric to the catch above) so a
        // retry re-opens a thread instead of forever sending turns on undefined.
        this.sessions.delete(requestId)
        this.emit(requestId, { type: 'error', message: 'Codex не вернул идентификатор треда' })
        return
      }
      session.threadId = threadId
      this.threadToRequest.set(threadId, requestId)
      this.emit(requestId, {
        type: 'init',
        sessionId: threadId,
        model: res.model ?? opts.model ?? '',
        cwd: res.cwd ?? opts.cwd ?? '',
        permissionMode: approvalPolicy,
        tools: [],
        effort: res.reasoningEffort ?? opts.effort
      })
    }

    // Re-sync live-adjustable opts on every turn: a follow-up start() reuses the
    // session from the first turn, and effort/cwd have no live setter otherwise,
    // so a mid-conversation effort change would be silently lost.
    if (opts.model !== undefined) session.model = codexModel(opts.model)
    if (opts.effort !== undefined) session.effort = codexEffort(opts.effort)
    if (opts.bypass !== undefined) session.bypass = opts.bypass

    await this.startTurn(requestId, session, opts.prompt)
  }

  private async startTurn(requestId: string, session: CodexSession, text: string): Promise<void> {
    try {
      const res = (await this.request(CODEX_METHOD.turnStart, {
        threadId: session.threadId,
        input: [{ type: 'text', text }],
        model: session.model,
        effort: session.effort,
        approvalPolicy: session.bypass ? 'never' : 'on-request'
      })) as CodexTurnStartResponse
      session.turnId = res?.turn?.id
    } catch (e) {
      this.emit(requestId, { type: 'error', message: friendlyError(e) })
    }
  }

  input(requestId: string, text: string): void {
    const session = this.sessions.get(requestId)
    if (!session?.threadId) return
    void this.startTurn(requestId, session, text)
  }

  interrupt(requestId: string): void {
    const s = this.sessions.get(requestId)
    if (!s) return
    // Decline any open approval gates first — otherwise the app-server keeps
    // waiting on server-requests we'll never answer once the turn is cancelled.
    for (const jsonRpcId of s.approvals.values()) this.respond(jsonRpcId, { decision: 'decline' })
    s.approvals.clear()
    if (s.threadId)
      this.request(CODEX_METHOD.turnInterrupt, { threadId: s.threadId, turnId: s.turnId }).catch(() => {})
  }

  /** Reply to a pending approval gate from a renderer approve/deny click. */
  resolvePermission(requestId: string, toolUseId: string, decision: AgentPermissionDecision): void {
    const session = this.sessions.get(requestId)
    const jsonRpcId = session?.approvals.get(toolUseId)
    if (jsonRpcId === undefined) return
    session!.approvals.delete(toolUseId)
    // Guard a malformed decision (renderer bug): anything but an explicit allow
    // fails closed to decline.
    this.respond(jsonRpcId, { decision: decision?.behavior === 'allow' ? 'accept' : 'decline' })
  }

  setModel(requestId: string, model: string | undefined): void {
    const s = this.sessions.get(requestId)
    if (s) s.model = codexModel(model)
  }
  setEffort(requestId: string, effort: string | undefined): void {
    const s = this.sessions.get(requestId)
    if (s) s.effort = codexEffort(effort)
  }
  setBypass(requestId: string, bypass: boolean): void {
    const s = this.sessions.get(requestId)
    if (s) s.bypass = bypass
  }

  async listModels(): Promise<AgentModelInfo[]> {
    try {
      await this.ensureServer()
      const res = (await this.request(CODEX_METHOD.modelList, {})) as {
        data?: Array<{
          id: string
          model?: string
          displayName?: string
          description?: string
          hidden?: boolean
          supportedReasoningEfforts?: unknown[]
        }>
      }
      const data = res?.data
      if (Array.isArray(data) && data.length) {
        return data
          .filter((m) => m && !m.hidden)
          .map((m) => ({
            value: m.id,
            resolvedModel: m.model,
            displayName: m.displayName ?? m.id,
            description: m.description,
            supportsEffort: Array.isArray(m.supportedReasoningEfforts)
              ? m.supportedReasoningEfforts.length > 0
              : true
          }))
      }
    } catch {
      /* fall through to the static catalog */
    }
    return CODEX_STATIC_MODELS
  }

  /** Is the codex binary present/runnable? Gates whether the engine is offered. */
  async probe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (v: boolean): void => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      try {
        const p = spawn(CODEX_BIN, ['--version'], { stdio: 'ignore' })
        p.on('error', () => finish(false))
        p.on('exit', (code) => finish(code === 0))
        setTimeout(() => {
          try {
            p.kill()
          } catch {
            /* ignore */
          }
          finish(false)
        }, 3000)
      } catch {
        finish(false)
      }
    })
  }

  killAll(): void {
    for (const w of this.pending.values()) w.reject(new Error('Codex остановлен'))
    this.pending.clear()
    this.sessions.clear()
    this.threadToRequest.clear()
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = undefined
    this.ready = undefined
    this.decoder = new JsonlDecoder()
    this.lastStderr = ''
  }
}
