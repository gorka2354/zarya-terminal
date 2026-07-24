import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'path'
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
import { JsonlDecoder, classifyJsonRpc, type RpcInbound } from './jsonlRpc'
import {
  ACP_METHOD,
  ACP_NOTIFY,
  ACP_PROTOCOL_VERSION,
  ACP_SERVER_REQUEST,
  pickOptionId,
  type AcpContentBlock,
  type AcpFsReadParams,
  type AcpFsWriteParams,
  type AcpNewSessionResult,
  type AcpPermissionOption,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpSessionUpdateParams,
  type AcpUpdate
} from './acpProtocol'

/** Timeout for control requests (initialize/session-new). session/prompt is
 *  exempt — a turn can legitimately run for minutes; it ends on its own result,
 *  cancel, or the server dying. */
const REQUEST_TIMEOUT_MS = 120_000

/** Launch + capability config for one ACP engine (gemini/kimi/qwen). */
export interface AcpEngineConfig {
  bin: string
  args: string[]
  capabilities: AgentCapabilities
  /** Shown when the binary isn't installed. */
  installHint: string
}

/**
 * Default ACP capability profile, shared by Gemini/Qwen (and Kimi for now). ACP
 * has no reasoning-effort dial and no subscription gauge; models come from
 * session/new (so modelsWithoutSession:false); gemini-cli disables ask_user in
 * ACP mode (structuredQuestions:false). Kimi's YOLO/Auto modes may expose
 * structured questions — revisit empirically when a real kimi is available.
 */
export const ACP_CAPABILITIES: AgentCapabilities = {
  // models:false — ACP fixes the model at session/new and exposes no live model
  // list/switch here yet; advertising it would render a control that can't
  // populate. Revisit if session model-switching is wired.
  models: false,
  modelsWithoutSession: false,
  effort: false,
  bypass: true,
  resumableSessions: true,
  usage: false,
  structuredQuestions: false
}

/** Parse a `ZARYA_*_ARGS` JSON override, falling back to defaults (for tests). */
export function parseAcpArgs(raw: string | undefined, def: string[]): string[] {
  if (!raw) return def
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.map(String) : def
  } catch {
    return def
  }
}

interface AcpSession {
  sessionId?: string
  /** Accumulated agent_message_chunk text for the in-flight turn (emitted whole
   *  on the prompt result, since the renderer's 'assistant' event appends). */
  pendingText: string
  /** toolCallId -> the permission request awaiting our reply. */
  permissions: Map<string, { jsonRpcId: number | string; options: AcpPermissionOption[] }>
  /** toolCallIds already turned into a tool_result this turn (dedup). */
  completedTools: Set<string>
  /** A prompt is in flight — guards against a second concurrent session/prompt. */
  inFlight?: boolean
  cwd?: string
  model?: string
}

function friendlyError(e: unknown, installHint: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/ENOENT|not found|не найден/i.test(msg)) return installHint
  if (/auth|login|unauthor|-32000/i.test(msg)) return 'Агент не авторизован — войди в аккаунт CLI и повтори.'
  return msg
}

function chunkText(content: AcpContentBlock | undefined): string {
  if (!content) return ''
  if (content.type === 'text') return String((content as { text?: unknown }).text ?? '')
  return ''
}

/** Lexical containment: is `target` inside `root` (no `..` traversal, no
 *  absolute/other-drive escape)? First half of the fs-proxy boundary. */
export function isWithinRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Real (symlink-resolved) containment — the second half of the boundary.
 * Lexical checks alone miss a symlink/junction inside cwd that points outside
 * (on Windows a junction needs no admin), which would let fs write/read escape.
 * We realpath the deepest EXISTING ancestor of `abs` (a write target may not
 * exist yet) and require it to stay within realpath(cwd). realpath failure →
 * refuse (fail closed).
 */
export function isRealWithinRoot(abs: string, cwd: string): boolean {
  try {
    const realCwd = realpathSync.native(cwd)
    let probe = abs
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
    const realProbe = realpathSync.native(probe)
    return realProbe === realCwd || isWithinRoot(realProbe, realCwd)
  } catch {
    return false
  }
}

/** Map an ACP ToolKind onto a renderer-friendly tool label. */
function acpToolName(kind?: string): string {
  switch (kind) {
    case 'execute':
      return 'Bash'
    case 'edit':
      return 'Edit'
    case 'read':
      return 'Read'
    case 'delete':
      return 'Delete'
    case 'search':
      return 'Search'
    default:
      return kind || 'Tool'
  }
}

/**
 * Native driver over ACP (Agent Client Protocol) — one class, parameterized per
 * engine (`gemini --acp`, `kimi acp`, `qwen --acp`). ONE long-lived child per
 * engine multiplexes conversations by ACP sessionId mapped from `requestId`.
 * Tool approvals arrive as `session/request_permission` server-requests and
 * surface to the renderer as `permission` events. See inc-11 plan.
 *
 * Hardened from the Codex (inc-10) review up front: request timeout, String(id)
 * pending keys, exit-handler that notifies + clears sessions, stale-proc guard,
 * coerced untrusted strings, fail-closed decisions.
 */
export class AcpDriver implements AgentDriver {
  readonly engine: AgentEngine
  readonly capabilities: AgentCapabilities
  private cfg: AcpEngineConfig
  private getWindow: () => BrowserWindow | null
  private proc?: ChildProcess
  private decoder = new JsonlDecoder()
  private nextId = 1
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private sessions = new Map<string, AcpSession>()
  private sessionToRequest = new Map<string, string>()
  private ready?: Promise<void>
  private lastStderr = ''

  constructor(engine: AgentEngine, cfg: AcpEngineConfig, getWindow: () => BrowserWindow | null) {
    this.engine = engine
    this.cfg = cfg
    this.capabilities = cfg.capabilities
    this.getWindow = getWindow
  }

  private emit(requestId: string, ev: AgentStreamEvent): void {
    this.getWindow()?.webContents.send(CH.agentStream, requestId, this.engine, ev)
  }

  // --- transport (ndjson JSON-RPC 2.0) ----------------------------------

  private write(msg: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }

  private request(method: string, params: unknown, opts?: { timeout?: number | null }): Promise<unknown> {
    const id = this.nextId++
    const key = String(id)
    const timeoutMs = opts?.timeout === undefined ? REQUEST_TIMEOUT_MS : opts.timeout
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs != null) {
        timer = setTimeout(() => {
          if (this.pending.delete(key)) reject(new Error(`${this.engine}: нет ответа на ${method} (таймаут)`))
        }, timeoutMs)
      }
      this.pending.set(key, {
        resolve: (v) => {
          if (timer) clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          if (timer) clearTimeout(timer)
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

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } })
  }

  private ensureServer(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawn(this.cfg.bin, this.cfg.args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        this.ready = undefined
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      this.proc = proc
      proc.on('error', (e) => {
        if (this.proc !== proc) return
        this.ready = undefined
        reject(e)
      })
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => this.onData(chunk))
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (d: string) => {
        this.lastStderr = (this.lastStderr + d).slice(-2000)
      })
      proc.on('exit', () => {
        if (this.proc !== proc) return
        const tail = this.lastStderr.trim()
        const err = new Error(tail ? `${this.engine} завершился: ${tail}` : `${this.engine} завершился`)
        for (const w of this.pending.values()) w.reject(err)
        this.pending.clear()
        const msg = friendlyError(err, this.cfg.installHint)
        for (const requestId of this.sessions.keys()) this.emit(requestId, { type: 'error', message: msg })
        this.sessions.clear()
        this.sessionToRequest.clear()
        this.proc = undefined
        this.ready = undefined
      })
      // ACP handshake: initialize (declare client capabilities) -> response.
      // No `initialized` follow-up (unlike Codex). We proxy fs so reads/writes
      // route through us, letting us confine them to the session cwd (§4).
      this.request(ACP_METHOD.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'zarya', title: 'Zarya', version: '0.4.0' }
      })
        .then(() => resolve())
        .catch((e) => {
          // A handshake that errors or times out (a live-but-wedged server, auth
          // / version mismatch) must NOT leave `ready` pointing at a rejected
          // promise with an orphan child — that wedges the engine until quit.
          // Reset so the next start() respawns and retries.
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
      // Untrusted agent JSON — a handler throwing here would take down the
      // stdout listener (and main). Isolate each message.
      try {
        const c = classifyJsonRpc(msg)
        if (c) this.handleInbound(c)
      } catch {
        /* swallow — one bad message can't wedge the transport */
      }
    }
  }

  private handleInbound(c: RpcInbound): void {
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

  private routeSession(sessionId?: string): string | undefined {
    return sessionId ? this.sessionToRequest.get(sessionId) : undefined
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== ACP_NOTIFY.sessionUpdate) return
    const p = params as AcpSessionUpdateParams | undefined
    const requestId = this.routeSession(p?.sessionId)
    if (!requestId) return
    const session = this.sessions.get(requestId)
    if (!session) return
    const update = p!.update as AcpUpdate
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk':
        // Accumulate; emitted whole on the prompt result (renderer appends).
        session.pendingText += chunkText((update as { content?: AcpContentBlock }).content)
        break
      case 'tool_call':
      case 'tool_call_update': {
        const u = update as { toolCallId?: string; status?: string; content?: unknown[] }
        if (u.status === 'completed' || u.status === 'failed') {
          const tid = String(u.toolCallId ?? '')
          // Emit exactly one tool_result per toolCallId (a server may report
          // completed on both the tool_call and a tool_call_update).
          if (!session.completedTools.has(tid)) {
            session.completedTools.add(tid)
            this.emit(requestId, { type: 'tool_result', toolUseId: tid, content: '', isError: u.status === 'failed' })
          }
        }
        break
      }
      // agent_thought_chunk / plan / usage_update: not surfaced in the MVP.
    }
  }

  private handleServerRequest(c: Extract<RpcInbound, { kind: 'serverRequest' }>): void {
    if (c.method === ACP_SERVER_REQUEST.requestPermission) {
      this.handlePermissionRequest(c)
      return
    }
    if (c.method === ACP_SERVER_REQUEST.fsReadTextFile) {
      this.handleFsRead(c)
      return
    }
    if (c.method === ACP_SERVER_REQUEST.fsWriteTextFile) {
      this.handleFsWrite(c)
      return
    }
    this.respondError(c.id, -32601, `method ${c.method} not handled`)
  }

  /** Resolve `path` against the session cwd, refusing anything outside it —
   *  both lexically and after resolving symlinks. `path` is untrusted agent
   *  JSON: a non-string (guarded here) would otherwise throw out of the stdout
   *  handler and crash main. */
  private resolveInCwd(sessionId: string | undefined, path: unknown): string | null {
    const requestId = this.routeSession(sessionId)
    const cwd = requestId ? this.sessions.get(requestId)?.cwd : undefined
    if (!cwd || typeof path !== 'string' || path === '') return null
    const abs = resolvePath(cwd, path)
    const lexicalOk = isWithinRoot(abs, cwd) || abs === resolvePath(cwd)
    if (!lexicalOk || !isRealWithinRoot(abs, cwd)) return null
    return abs
  }

  /** fs/read_text_file proxy — confined to the session cwd. */
  private handleFsRead(c: Extract<RpcInbound, { kind: 'serverRequest' }>): void {
    const p = c.params as AcpFsReadParams | undefined
    const abs = this.resolveInCwd(p?.sessionId, p?.path)
    if (!abs) {
      this.respondError(c.id, -32000, 'Путь вне рабочей директории сессии')
      return
    }
    try {
      let content = readFileSync(abs, 'utf8')
      if (p?.line != null || p?.limit != null) {
        const lines = content.split('\n')
        const start = Math.max(0, (p?.line ?? 1) - 1)
        content = lines.slice(start, p?.limit != null ? start + p.limit : undefined).join('\n')
      }
      this.respond(c.id, { content })
    } catch (e) {
      this.respondError(c.id, -32000, `Чтение не удалось: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * fs/write_text_file proxy — the security boundary. The agent controls the
   * path; we write ONLY inside the session cwd (traversal / absolute escape →
   * error), so a turn can't be tricked into clobbering files outside the project.
   */
  private handleFsWrite(c: Extract<RpcInbound, { kind: 'serverRequest' }>): void {
    const p = c.params as AcpFsWriteParams | undefined
    const abs = this.resolveInCwd(p?.sessionId, p?.path)
    if (!abs) {
      this.respondError(c.id, -32000, 'Запись вне рабочей директории сессии запрещена')
      return
    }
    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, String(p?.content ?? ''))
      this.respond(c.id, null)
    } catch (e) {
      this.respondError(c.id, -32000, `Запись не удалась: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * A tool-permission gate (agent -> client request). Surfaces as a `permission`
   * event; resolvePermission() replies by echoing the chosen opaque optionId.
   * Unroutable / duplicate gates fail closed to `cancelled` so nothing hangs and
   * nothing is auto-approved.
   */
  private handlePermissionRequest(c: Extract<RpcInbound, { kind: 'serverRequest' }>): void {
    const params = c.params as AcpRequestPermissionParams | undefined
    const requestId = this.routeSession(params?.sessionId)
    const session = requestId ? this.sessions.get(requestId) : undefined
    const toolCallId = params?.toolCall?.toolCallId
    if (!requestId || !session || !toolCallId) {
      this.respond(c.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const toolUseId = String(toolCallId)
    if (session.permissions.has(toolUseId)) {
      this.respond(c.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    session.permissions.set(toolUseId, { jsonRpcId: c.id, options: params!.options ?? [] })
    this.emit(requestId, {
      type: 'permission',
      toolUseId,
      toolName: acpToolName(params!.toolCall.kind),
      input: {
        title: String(params!.toolCall.title ?? ''),
        kind: String(params!.toolCall.kind ?? '')
      },
      displayName: String(params!.toolCall.title ?? 'Действие агента')
    })
  }

  // --- AgentDriver surface ----------------------------------------------

  async start(requestId: string, opts: AgentStartOpts): Promise<void> {
    try {
      await this.ensureServer()
    } catch (e) {
      this.emit(requestId, { type: 'error', message: friendlyError(e, this.cfg.installHint) })
      return
    }

    let session = this.sessions.get(requestId)
    if (!session) {
      session = { pendingText: '', permissions: new Map(), completedTools: new Set(), cwd: opts.cwd }
      this.sessions.set(requestId, session)
      const cwd = opts.cwd || process.cwd()
      let res: unknown
      try {
        res = opts.resume
          ? await this.request(ACP_METHOD.sessionLoad, { sessionId: opts.resume, cwd, mcpServers: [] })
          : await this.request(ACP_METHOD.sessionNew, { cwd, mcpServers: [] })
      } catch (e) {
        this.sessions.delete(requestId)
        this.emit(requestId, { type: 'error', message: friendlyError(e, this.cfg.installHint) })
        return
      }
      const sessionId = opts.resume || (res as AcpNewSessionResult)?.sessionId
      if (!sessionId) {
        this.sessions.delete(requestId)
        this.emit(requestId, { type: 'error', message: `${this.engine} не вернул sessionId` })
        return
      }
      session.sessionId = sessionId
      this.sessionToRequest.set(sessionId, requestId)
      session.model = (res as AcpNewSessionResult)?.models?.currentModelId
      this.emit(requestId, {
        type: 'init',
        sessionId,
        model: session.model ?? '',
        cwd,
        permissionMode: 'default',
        tools: []
      })
    }

    await this.runPrompt(requestId, session, opts.prompt)
  }

  private async runPrompt(requestId: string, session: AcpSession, text: string): Promise<void> {
    if (session.inFlight) return // one prompt in flight per ACP session
    session.inFlight = true
    session.pendingText = ''
    session.completedTools = new Set()
    try {
      // No timeout: a turn may run for minutes; it ends on its own result/cancel.
      const res = (await this.request(
        ACP_METHOD.sessionPrompt,
        { sessionId: session.sessionId, prompt: [{ type: 'text', text }] },
        { timeout: null }
      )) as AcpPromptResult
      if (session.pendingText) {
        this.emit(requestId, { type: 'assistant', content: [{ type: 'text', text: session.pendingText }] })
        session.pendingText = ''
      }
      const stop = res?.stopReason
      this.emit(requestId, { type: 'result', isError: stop === 'refusal', result: stop })
    } catch (e) {
      // Skip if the session was already torn down (exit-handler emitted its own
      // error) — avoids a duplicate error event for the same conversation.
      if (this.sessions.has(requestId))
        this.emit(requestId, { type: 'error', message: friendlyError(e, this.cfg.installHint) })
    } finally {
      session.inFlight = false
    }
  }

  input(requestId: string, text: string): void {
    const session = this.sessions.get(requestId)
    if (!session?.sessionId) return
    void this.runPrompt(requestId, session, text)
  }

  interrupt(requestId: string): void {
    const s = this.sessions.get(requestId)
    if (!s) return
    // Per ACP: after session/cancel the client answers every pending
    // request_permission with `cancelled`. Do that first so nothing strands.
    for (const { jsonRpcId } of s.permissions.values())
      this.respond(jsonRpcId, { outcome: { outcome: 'cancelled' } })
    s.permissions.clear()
    if (s.sessionId) this.notify(ACP_METHOD.sessionCancel, { sessionId: s.sessionId })
  }

  /** Reply to a session/request_permission gate from a renderer approve/deny. */
  resolvePermission(requestId: string, toolUseId: string, decision: AgentPermissionDecision): void {
    const session = this.sessions.get(requestId)
    const pending = session?.permissions.get(toolUseId)
    if (!pending) return
    session!.permissions.delete(toolUseId)
    const allow = decision?.behavior === 'allow'
    // optionId is opaque — pick by kind. No matching option → fail closed to
    // cancelled rather than risk echoing the wrong outcome.
    const optionId = pickOptionId(pending.options, allow)
    this.respond(
      pending.jsonRpcId,
      optionId !== undefined
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    )
  }

  setModel(): void {}
  setEffort(): void {}
  setBypass(): void {}

  async listModels(): Promise<AgentModelInfo[]> {
    return []
  }

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
        const p = spawn(this.cfg.bin, ['--version'], { stdio: 'ignore' })
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
    for (const w of this.pending.values()) w.reject(new Error(`${this.engine} остановлен`))
    this.pending.clear()
    this.sessions.clear()
    this.sessionToRequest.clear()
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
