/**
 * Narrow TypeScript view of the `codex app-server` JSON-RPC protocol — ONLY the
 * methods, notifications and payload fields the CodexDriver actually uses. The
 * full protocol (openai/codex@fe8500c0, `codex-rs/app-server-protocol`) is far
 * larger; this file is the driver's contract with it, kept deliberately small.
 *
 * Wire notes: JSONL over stdio, JSON-RPC "lite" (NO `"jsonrpc":"2.0"` member).
 * `id`-bearing messages are requests/responses; the server also sends requests
 * (approval gates). Reasoning effort is set per-turn via `turn/start.effort`.
 */

/** Client -> server request methods we send. */
export const CODEX_METHOD = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list'
} as const

/** Client -> server notification (no id, no response). */
export const CODEX_CLIENT_NOTIFY = {
  initialized: 'initialized'
} as const

/** Server -> client notification methods we map onto AgentStreamEvents. */
export const CODEX_NOTIFY = {
  turnStarted: 'turn/started',
  itemStarted: 'item/started',
  agentMessageDelta: 'item/agentMessage/delta',
  itemCompleted: 'item/completed',
  turnCompleted: 'turn/completed',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  tokenUsage: 'thread/tokenUsage/updated',
  serverRequestResolved: 'serverRequest/resolved'
} as const

/**
 * Server -> client REQUEST methods (approval gates for turns started via
 * `turn/start`). Each carries an `id`; the client MUST reply with `{decision}`.
 */
export const CODEX_APPROVAL = {
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval'
} as const

// --- Narrow payload shapes (only the fields the driver reads) ---

/** `thread/start` / `thread/resume` response — id lives at `result.thread.id`. */
export interface CodexThread {
  id: string
  sessionId?: string
  cwd?: string
  modelProvider?: string
  preview?: string
}
export interface CodexThreadStartResponse {
  thread: CodexThread
  /** Effective model, on the response envelope (not inside `thread`). */
  model?: string
  cwd?: string
  reasoningEffort?: string | null
}

/** `turn/start` response — id lives at `result.turn.id`. */
export interface CodexTurn {
  id: string
  status?: string
  error?: { message?: string } | null
}
export interface CodexTurnStartResponse {
  turn: CodexTurn
}

/**
 * A thread item. Only the variants the driver renders are typed precisely; any
 * other item type falls through the `{ type: string }` arm and is ignored.
 */
export type CodexItem =
  | { type: 'agentMessage'; id: string; text: string }
  | {
      type: 'commandExecution'
      id: string
      command?: string
      cwd?: string
      aggregatedOutput?: string | null
      exitCode?: number | null
      status?: string
    }
  | { type: 'fileChange'; id: string; status?: string }
  | { type: string; id?: string }

// Notification payloads.
export interface CodexItemNotification {
  item: CodexItem
  threadId?: string
  turnId?: string
}
export interface CodexTurnNotification {
  threadId?: string
  turn: CodexTurn
}

// Approval-request params (server -> client). itemId is the gate key we surface
// to the renderer as toolUseId; the JSON-RPC request id is how we reply.
export interface CodexCommandApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  command?: string | null
  cwd?: string | null
  reason?: string | null
}
export interface CodexFileChangeApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
}

/**
 * The command/fileChange approval decision the client sends back. The full
 * enum also has "acceptForSession"/"cancel"/amendment variants; the driver maps
 * allow -> "accept", deny -> "decline".
 */
export type CodexApprovalDecision = 'accept' | 'decline' | 'acceptForSession' | 'cancel'

/**
 * The renderer dispatches a generic opts superset sourced from Claude settings
 * (per the inc-9 "driver owns behaviour" decision). Codex only understands its
 * own model ids and a 3-level reasoning effort, so the driver filters through
 * these before sending.
 *
 * codexModel: drop a non-Codex model id (e.g. 'opus') so the Codex account
 * default applies instead of erroring.
 * codexEffort: clamp Claude-only tiers 'xhigh'/'max' (incl. ultracode's forced
 * 'xhigh') to 'high'; pass low/medium/high through; drop anything else.
 */
export function codexModel(m?: string): string | undefined {
  return m && /^(gpt|o[0-9]|codex)/i.test(m) ? m : undefined
}
export function codexEffort(e?: string): string | undefined {
  if (!e) return undefined
  if (e === 'xhigh' || e === 'max') return 'high'
  return e === 'low' || e === 'medium' || e === 'high' ? e : undefined
}
