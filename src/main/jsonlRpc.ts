/**
 * Pure JSON-RPC framing over a newline-delimited (JSONL) stdio stream — shared
 * by every stdio agent transport (Codex app-server's "lite" JSON-RPC and ACP's
 * full JSON-RPC 2.0 both frame identically: one JSON value per line). No process,
 * no Electron — kept side-effect-free so it is unit-tested in isolation.
 *
 * Two jobs: (1) turn a byte-stream of chunks into parsed messages, robust to
 * chunk boundaries and bounded against a runaway line; (2) classify each message
 * as a response to one of our requests, a server-initiated request, or a
 * notification. The `"jsonrpc":"2.0"` envelope member (present in ACP, absent in
 * Codex) is simply ignored — classification is by id/method/result shape.
 */

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** A classified inbound message. */
export type RpcInbound =
  | { kind: 'response'; id: number | string; result?: unknown; error?: RpcError }
  | { kind: 'serverRequest'; id: number | string; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }

function hasId(m: Record<string, unknown>): m is Record<string, unknown> & { id: number | string } {
  // id:0 is valid (initialize often uses id 0) — test presence and type, never
  // truthiness.
  return 'id' in m && (typeof m.id === 'number' || typeof m.id === 'string')
}

/**
 * Classify one already-parsed JSON message. Order matters: a server request
 * carries BOTH `id` and `method` (but no `result`), so it is checked before the
 * response arm. Returns null for anything that isn't a well-formed message.
 */
export function classifyJsonRpc(msg: unknown): RpcInbound | null {
  if (msg == null || typeof msg !== 'object' || Array.isArray(msg)) return null
  const m = msg as Record<string, unknown>
  const method = typeof m.method === 'string' ? m.method : undefined
  if (hasId(m) && method !== undefined) {
    return { kind: 'serverRequest', id: m.id, method, params: m.params }
  }
  if (hasId(m) && ('result' in m || 'error' in m)) {
    return { kind: 'response', id: m.id, result: m.result, error: m.error as RpcError | undefined }
  }
  if (method !== undefined) {
    return { kind: 'notification', method, params: m.params }
  }
  return null
}

/**
 * Hard cap on a single un-terminated JSONL line. The agent process is mostly
 * trusted, but a runaway tool output (or a hung/compromised server) can emit a
 * huge single line with no newline; without a bound `buf += chunk` grows until
 * it OOMs the main process (or throws RangeError at V8's ~512MB string limit
 * inside the stdout handler). 48 MB is generous for legitimate tool output yet
 * bounded — an over-length line is dropped, not accumulated.
 */
export const MAX_JSONL_LINE = 48 * 1024 * 1024

/**
 * Streaming JSONL decoder. Feed raw stdout chunks (which may split a line at any
 * byte, or pack several lines together); get back the JSON values of every
 * completed line. A partial trailing line stays buffered until its newline
 * arrives. Malformed lines are skipped rather than throwing, so one bad line
 * can't wedge the stream. An over-length un-terminated line is dropped (see
 * {@link MAX_JSONL_LINE}) so it can't exhaust memory.
 */
export class JsonlDecoder {
  private buf = ''
  /** True while discarding the remainder of an over-length line up to its \n. */
  private dropping = false

  push(chunk: string): unknown[] {
    this.buf += chunk
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (this.dropping) {
        // This newline terminates the over-length line we were discarding.
        this.dropping = false
        continue
      }
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip a malformed line — keep the stream alive */
      }
    }
    // A still-unterminated tail past the cap: drop it and enter dropping mode so
    // the rest of that line (until its \n) is discarded too. Bounds memory.
    if (this.buf.length > MAX_JSONL_LINE) {
      this.buf = ''
      this.dropping = true
    }
    return out
  }

  /** Bytes buffered but not yet terminated by a newline (diagnostics/tests). */
  get pending(): string {
    return this.buf
  }
}

/** Decode a chunk and classify every complete message in it, in one pass. */
export function decodeJsonRpcChunk(decoder: JsonlDecoder, chunk: string): RpcInbound[] {
  const out: RpcInbound[] = []
  for (const msg of decoder.push(chunk)) {
    const c = classifyJsonRpc(msg)
    if (c) out.push(c)
  }
  return out
}
