/**
 * Mock ACP agent for the AcpDriver harness. Speaks the REAL wire protocol:
 * ndjson JSON-RPC 2.0 (with the "jsonrpc":"2.0" envelope), initialize handshake,
 * session/new + session/load, session/prompt with streamed agent_message_chunk
 * deltas, a session/request_permission gate (for prompts mentioning "tool"/
 * "run"), fs/write_text_file proxy (for "writefile"), session/cancel, plus
 * crash/slow modes. Deterministic — no real Gemini. Driven via ZARYA_GEMINI_BIN
 * =node + ZARYA_GEMINI_ARGS=[thisPath].
 */
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'

if (process.argv.includes('--version')) {
  process.stdout.write('gemini-mock 0.0.0\n')
  process.exit(0)
}
if (process.env.ZARYA_ACP_PID_FILE) {
  try {
    writeFileSync(process.env.ZARYA_ACP_PID_FILE, String(process.pid))
  } catch {
    /* best-effort */
  }
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const approvalLog = process.env.ZARYA_ACP_APPROVAL_LOG
const fsLog = process.env.ZARYA_ACP_FS_LOG
const logLine = (file, obj) => {
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify(obj) + '\n')
  } catch {
    /* best-effort */
  }
}

let sessSeq = 0
let callSeq = 0
let reqSeq = 7000
const prompts = new Map() // sessionId -> { promptId, done }
const clientReplies = new Map() // our server-request id -> callback(result)

const rl = createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params, result } = msg

  // A client RESPONSE to one of our server-requests (permission outcome / fs).
  if (id != null && method === undefined && result !== undefined && clientReplies.has(id)) {
    const cb = clientReplies.get(id)
    clientReplies.delete(id)
    cb(result)
    return
  }

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: {} },
          authMethods: [],
          agentInfo: { name: 'gemini-mock', title: 'Gemini Mock', version: '0.0.0' }
        }
      })
      break
    case 'authenticate':
      send({ id, result: {} })
      break
    case 'session/new': {
      const sid = `sess_${++sessSeq}`
      send({
        id,
        result: {
          sessionId: sid,
          models: {
            availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
            currentModelId: 'gemini-2.5-pro'
          }
        }
      })
      break
    }
    case 'session/load':
      // Resume: (optionally replay history via session/update) then null.
      send({ id, result: null })
      break
    case 'session/prompt':
      runPrompt(id, params)
      break
    case 'session/cancel':
      cancelPrompt(params?.sessionId)
      break
    default:
      if (id != null) send({ id, result: {} })
  }
})

function runPrompt(promptId, params) {
  const sid = params?.sessionId
  const text = (params?.prompt ?? [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join(' ')
  prompts.set(sid, { promptId, done: false })
  const at = (ms, fn) => setTimeout(fn, ms)

  // Stream the assistant reply as two chunks (tests chunk accumulation).
  at(10, () =>
    send({
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'gemini ' } } }
    })
  )
  at(20, () =>
    send({
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mock: ${text}` } } }
    })
  )

  if (/crash/i.test(text)) {
    at(30, () => process.exit(1))
    return
  }
  if (/slow/i.test(text)) {
    return // no result until session/cancel
  }
  if (/writefile/i.test(text)) {
    // fs/write proxy: ask the client to write inside cwd, then finish.
    const rid = ++reqSeq
    at(30, () => {
      clientReplies.set(rid, (res) => {
        logLine(fsLog, { kind: 'write', ok: res === null || res === undefined })
        finishPrompt(sid)
      })
      send({
        id: rid,
        method: 'fs/write_text_file',
        params: { sessionId: sid, path: `${params?.cwd ?? '.'}/zarya-acp-test.txt`, content: 'hello from gemini\n' }
      })
    })
    // A second write attempt OUTSIDE cwd (path traversal) — must be rejected.
    const rid2 = ++reqSeq
    at(60, () => {
      clientReplies.set(rid2, (res) => logLine(fsLog, { kind: 'traversal-unexpected-ok', res }))
      send({
        id: rid2,
        method: 'fs/write_text_file',
        params: { sessionId: sid, path: '/etc/zarya-escape.txt', content: 'escape' }
      })
    })
    return
  }
  if (/tool|run/i.test(text)) {
    const callId = `call_${++callSeq}`
    at(30, () =>
      send({
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: callId, title: 'Run ls', kind: 'execute', status: 'pending' } }
      })
    )
    const rid = ++reqSeq
    at(35, () => {
      clientReplies.set(rid, (res) => {
        const outcome = res?.outcome?.outcome
        const optionId = res?.outcome?.optionId
        logLine(approvalLog, { callId, outcome, optionId })
        if (outcome === 'selected') {
          send({
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: callId,
                status: /allow/i.test(optionId || '') ? 'completed' : 'failed'
              }
            }
          })
        }
        finishPrompt(sid)
      })
      send({
        id: rid,
        method: 'session/request_permission',
        params: {
          sessionId: sid,
          toolCall: { toolCallId: callId, title: 'Run ls', kind: 'execute' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
          ]
        }
      })
    })
    return
  }
  at(40, () => finishPrompt(sid))
}

function finishPrompt(sid) {
  const st = prompts.get(sid)
  if (!st || st.done) return
  st.done = true
  send({ id: st.promptId, result: { stopReason: 'end_turn' } })
}
function cancelPrompt(sid) {
  const st = prompts.get(sid)
  if (!st || st.done) return
  st.done = true
  send({ id: st.promptId, result: { stopReason: 'cancelled' } })
}
