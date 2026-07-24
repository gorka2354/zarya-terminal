/**
 * Codex-flavoured aliases over the shared {@link ./jsonlRpc} framer. The framer
 * is engine-agnostic (Codex + ACP both frame as JSONL JSON-RPC); this thin shim
 * keeps the Codex driver + its tests reading `CodexInbound`/`classifyCodexMessage`
 * without churn.
 */
export {
  JsonlDecoder,
  MAX_JSONL_LINE,
  classifyJsonRpc as classifyCodexMessage,
  decodeJsonRpcChunk as decodeCodexChunk
} from './jsonlRpc'
export type { RpcError as CodexRpcError, RpcInbound as CodexInbound } from './jsonlRpc'
