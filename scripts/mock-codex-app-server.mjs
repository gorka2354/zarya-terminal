/**
 * Mock `codex app-server` for the CodexDriver harness. Speaks the REAL wire
 * protocol (JSONL / JSON-RPC-lite, openai/codex@fe8500c0): initialize handshake,
 * thread/start+resume, turn/start with a streamed agentMessage, server-initiated
 * command-approval gate (for prompts mentioning "tool"/"run"), turn/interrupt,
 * model/list. Deterministic — no real Codex, no auth. Driven via ZARYA_CODEX_BIN
 * =node + ZARYA_CODEX_ARGS=[thisPath].
 */
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'

// `codex --version` probe path — exit 0 so the driver treats codex as installed.
if (process.argv.includes('--version')) {
  process.stdout.write('codex-mock 0.0.0\n')
  process.exit(0)
}

// Record our pid so the harness can assert the process is gone after quit
// (Windows .kill() is TerminateProcess — a SIGTERM handler wouldn't run, so
// liveness-by-pid is the portable teardown check).
if (process.env.ZARYA_CODEX_PID_FILE) {
  try {
    writeFileSync(process.env.ZARYA_CODEX_PID_FILE, String(process.pid))
  } catch {
    /* best-effort */
  }
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const killLog = process.env.ZARYA_CODEX_KILL_LOG
const approvalLog = process.env.ZARYA_CODEX_APPROVAL_LOG
const logKill = () => {
  if (killLog) {
    try {
      appendFileSync(killLog, 'codex\n')
    } catch {
      /* best-effort */
    }
  }
}
process.on('SIGTERM', () => {
  logKill()
  process.exit(0)
})
process.on('SIGINT', () => {
  logKill()
  process.exit(0)
})

let threadSeq = 0
let turnSeq = 0
let itemSeq = 0
let approvalSeq = 9000
const approvals = new Map() // server-request id -> { threadId, turnId, itemId }

const rl = createInterface({ input: process.stdin })
rl.on('close', () => {
  logKill()
  process.exit(0)
})

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = msg

  // A client RESPONSE to one of our approval requests ({id, result:{decision}}).
  if (id != null && method === undefined && msg.result !== undefined && approvals.has(id)) {
    const ctx = approvals.get(id)
    approvals.delete(id)
    const decision = msg.result?.decision
    if (approvalLog) {
      try {
        appendFileSync(approvalLog, JSON.stringify({ itemId: ctx.itemId, decision }) + '\n')
      } catch {
        /* best-effort */
      }
    }
    finishAfterApproval(ctx, decision)
    return
  }

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          userAgent: 'codex-mock',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'linux'
        }
      })
      break
    case 'initialized':
      break
    case 'thread/start': {
      const tid = `thr_${++threadSeq}`
      send({
        id,
        result: {
          thread: { id: tid, sessionId: tid, cwd: params?.cwd ?? '' },
          model: params?.model ?? 'gpt-5.1-codex',
          cwd: params?.cwd ?? ''
        }
      })
      break
    }
    case 'thread/resume': {
      const tid = params?.threadId ?? `thr_${++threadSeq}`
      send({
        id,
        result: { thread: { id: tid, sessionId: tid }, model: params?.model ?? 'gpt-5.1-codex' }
      })
      break
    }
    case 'turn/start': {
      const tid = params?.threadId
      const turnId = `turn_${++turnSeq}`
      send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
      const text = (params?.input ?? [])
        .filter((x) => x && x.type === 'text')
        .map((x) => x.text)
        .join(' ')
      runTurn(tid, turnId, text)
      break
    }
    case 'turn/interrupt': {
      send({ id, result: {} })
      send({
        method: 'turn/completed',
        params: { threadId: params?.threadId, turn: { id: params?.turnId, status: 'interrupted' } }
      })
      break
    }
    case 'model/list':
      send({
        id,
        result: {
          data: [
            {
              id: 'gpt-5.1-codex',
              model: 'gpt-5.1-codex',
              displayName: 'GPT-5.1 Codex',
              description: 'Codex model',
              hidden: false,
              supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }],
              defaultReasoningEffort: 'medium',
              isDefault: true
            },
            {
              id: 'gpt-5.1',
              model: 'gpt-5.1',
              displayName: 'GPT-5.1',
              description: '',
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium',
              isDefault: false
            },
            { id: 'internal-hidden', model: 'internal', displayName: 'hidden', hidden: true }
          ],
          nextCursor: null
        }
      })
      break
    default:
      if (id != null) send({ id, result: {} })
  }
})

function runTurn(tid, turnId, text) {
  const at = (ms, fn) => setTimeout(fn, ms)
  at(5, () => send({ method: 'turn/started', params: { threadId: tid, turn: { id: turnId } } }))
  const itemId = `item_${++itemSeq}`
  at(10, () =>
    send({
      method: 'item/started',
      params: { threadId: tid, turnId, item: { type: 'agentMessage', id: itemId, text: '' } }
    })
  )
  at(15, () =>
    send({ method: 'item/agentMessage/delta', params: { threadId: tid, turnId, itemId, delta: '…' } })
  )
  at(25, () =>
    send({
      method: 'item/completed',
      params: {
        threadId: tid,
        turnId,
        item: { type: 'agentMessage', id: itemId, text: `codex mock: ${text}` }
      }
    })
  )
  if (/crash/i.test(text)) {
    // Simulate the app-server dying mid-turn (no turn/completed) — exercises the
    // driver's exit-handler cleanup (P1): the conversation must get an error.
    at(30, () => process.exit(1))
  } else if (/slow/i.test(text)) {
    // Leave the turn in-flight: no turn/completed until a turn/interrupt arrives.
  } else if (/tool|run/i.test(text)) {
    // Gate a command via a server-initiated approval request; the turn only
    // completes once the client replies (see finishAfterApproval).
    const cmdItemId = `cmd_${++itemSeq}`
    const aid = ++approvalSeq
    approvals.set(aid, { threadId: tid, turnId, itemId: cmdItemId })
    at(35, () =>
      send({
        id: aid,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: tid, turnId, itemId: cmdItemId, command: 'echo hello', cwd: '/tmp' }
      })
    )
  } else {
    at(35, () =>
      send({ method: 'turn/completed', params: { threadId: tid, turn: { id: turnId, status: 'completed' } } })
    )
  }
}

function finishAfterApproval(ctx, decision) {
  const { threadId, turnId, itemId } = ctx
  if (decision === 'accept' || decision === 'acceptForSession') {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: itemId,
          command: 'echo hello',
          cwd: '/tmp',
          aggregatedOutput: 'hello\n',
          exitCode: 0,
          status: 'completed'
        }
      }
    })
  }
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed' } }
  })
}
