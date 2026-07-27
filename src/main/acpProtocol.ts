/**
 * Narrow TypeScript view of ACP (Agent Client Protocol) v1 — ONLY the methods,
 * notifications and fields the AcpDriver uses. Full spec:
 * zed-industries/agent-client-protocol@ac7639d, as implemented by
 * google-gemini/gemini-cli@69b51f8 (`gemini --acp`). Wire: ndjson JSON-RPC 2.0
 * over stdio (one JSON value per line, with the `"jsonrpc":"2.0"` envelope).
 *
 * ACP is flatter than Codex app-server: a single `session`, and ONE
 * `session/request_permission` gate for every tool (vs Codex's per-category
 * approval methods). Kimi (`kimi acp`) and Qwen (`qwen --acp`) speak the same
 * protocol, so this file backs all three engines.
 */

export const ACP_PROTOCOL_VERSION = 1

/** Client -> agent request/notification methods we send. */
export const ACP_METHOD = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel' // notification (no id)
} as const

/** Agent -> client notification we map onto AgentStreamEvents. */
export const ACP_NOTIFY = {
  sessionUpdate: 'session/update'
} as const

/** Agent -> client REQUESTS (carry an id; the client MUST reply). */
export const ACP_SERVER_REQUEST = {
  requestPermission: 'session/request_permission',
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file'
} as const

// --- Content ---
export interface AcpTextContent {
  type: 'text'
  text: string
}
export type AcpContentBlock = AcpTextContent | { type: string; [k: string]: unknown }

// --- Handshake / session ---
export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities?: { loadSession?: boolean }
  authMethods?: Array<{ id: string; name?: string }>
}
export interface AcpModelInfo {
  modelId?: string
  id?: string
  name?: string
}
export interface AcpNewSessionResult {
  sessionId: string
  models?: { availableModels?: AcpModelInfo[]; currentModelId?: string }
}
export interface AcpPromptResult {
  stopReason: string
}

// --- session/update ---
export interface AcpSessionUpdateParams {
  sessionId: string
  update: AcpUpdate
}
export type AcpUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title?: string
      kind?: string
      status?: string
      content?: unknown[]
    }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status?: string; content?: unknown[] }
  | { sessionUpdate: string; [k: string]: unknown }

// --- Permission (agent -> client request) ---
export type AcpPermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
export interface AcpPermissionOption {
  optionId: string
  name?: string
  kind?: AcpPermissionKind
}
export interface AcpRequestPermissionParams {
  sessionId: string
  toolCall: { toolCallId: string; title?: string; kind?: string; content?: unknown[] }
  options: AcpPermissionOption[]
}

// --- Filesystem proxy (agent -> client request) ---
export interface AcpFsReadParams {
  sessionId: string
  path: string
  line?: number
  limit?: number
}
export interface AcpFsWriteParams {
  sessionId: string
  path: string
  content: string
}

/**
 * Есть ли у гейта разовое разрешение.
 *
 * Если агент предлагает только «разрешить всегда», человек обязан это знать ДО
 * нажатия: одна и та же кнопка означает то разовый запуск, то постоянное
 * разрешение на всю сессию.
 */
export function hasAllowOnce(options: AcpPermissionOption[]): boolean {
  return !!options?.some((o) => o.kind === 'allow_once')
}

/**
 * Pick the optionId to answer `session/request_permission`. optionId strings are
 * OPAQUE (must be echoed verbatim), so selection is by `kind`, never by index.
 * Returns undefined when no matching kind exists — the driver then answers with
 * `{outcome:'cancelled'}` rather than risk selecting the wrong (e.g. an allow_*
 * option for a deny). Fail-closed by construction.
 *
 * SECURITY: разрешение НЕ повышается само. Раньше `allow` при отсутствии
 * `allow_once` молча выбирал `allow_always`: человек нажимал «ВЫПОЛНИТЬ», имея в
 * виду один запуск, а агент получал постоянное разрешение на всю сессию и
 * переставал спрашивать. Об этом нигде не говорилось — гейт, который тихо
 * отменяет сам себя, хуже отсутствующего, потому что создаёт ложную уверенность,
 * что спросят и в следующий раз.
 *
 * Теперь `allow_always` выбирается только когда вызывающий передал
 * `alwaysAllowed` — то есть человеку показали, что кнопка означает «всегда», и
 * он нажал именно её.
 *
 * Отказ повышается свободно: `reject_always` строже, чем `reject_once`, и
 * ошибиться в сторону «не запускать» безопасно.
 */
export function pickOptionId(
  options: AcpPermissionOption[],
  allow: boolean,
  alwaysAllowed = false
): string | undefined {
  const want: AcpPermissionKind[] = allow
    ? alwaysAllowed
      ? ['allow_once', 'allow_always']
      : ['allow_once']
    : ['reject_once', 'reject_always']
  for (const k of want) {
    const m = options?.find((o) => o.kind === k)
    if (m) return m.optionId
  }
  return undefined
}
