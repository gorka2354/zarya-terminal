import { describe, expect, it } from 'vitest'
import {
  JsonlDecoder,
  MAX_JSONL_LINE,
  classifyCodexMessage,
  decodeCodexChunk,
  type CodexInbound
} from '../src/main/codexRpc'

describe('JsonlDecoder', () => {
  it('parses multiple messages packed in one chunk', () => {
    const d = new JsonlDecoder()
    const out = d.push('{"id":1,"result":{}}\n{"method":"turn/started","params":{}}\n')
    expect(out).toEqual([
      { id: 1, result: {} },
      { method: 'turn/started', params: {} }
    ])
    expect(d.pending).toBe('')
  })

  it('reassembles a single message split across chunks', () => {
    const d = new JsonlDecoder()
    expect(d.push('{"id":10,"res')).toEqual([])
    expect(d.pending).toBe('{"id":10,"res')
    expect(d.push('ult":{"thread":{"id":"thr_1"}}}\n')).toEqual([
      { id: 10, result: { thread: { id: 'thr_1' } } }
    ])
    expect(d.pending).toBe('')
  })

  it('reassembles a line split exactly at the newline byte', () => {
    const d = new JsonlDecoder()
    expect(d.push('{"method":"a","params":1}')).toEqual([])
    expect(d.push('\n')).toEqual([{ method: 'a', params: 1 }])
  })

  it('ignores blank and whitespace-only lines', () => {
    const d = new JsonlDecoder()
    const out = d.push('\n  \n{"method":"x"}\n\n')
    expect(out).toEqual([{ method: 'x' }])
  })

  it('skips a malformed line but keeps parsing the rest', () => {
    const d = new JsonlDecoder()
    const out = d.push('{"method":"ok"}\nnot json at all\n{"id":2,"result":1}\n')
    expect(out).toEqual([{ method: 'ok' }, { id: 2, result: 1 }])
  })

  it('keeps a partial trailing line buffered until its newline arrives', () => {
    const d = new JsonlDecoder()
    d.push('{"method":"one"}\n{"method":"tw')
    expect(d.pending).toBe('{"method":"tw')
    const out = d.push('o"}\n')
    expect(out).toEqual([{ method: 'two' }])
  })

  it('drops an over-length un-terminated line (DoS guard) and recovers on the next newline', () => {
    const d = new JsonlDecoder()
    // 60 MB with no newline (a runaway/hostile server), in 10 MB chunks.
    for (let i = 0; i < 6; i++) d.push('x'.repeat(10 * 1024 * 1024))
    // Buffer stayed bounded — never grew to the full 60 MB.
    expect(d.pending.length).toBeLessThanOrEqual(MAX_JSONL_LINE)
    // The tail of the giant line + its newline is discarded; the next line parses.
    const out = d.push('tail-of-giant\n{"method":"recovered"}\n')
    expect(out).toEqual([{ method: 'recovered' }])
  })
})

describe('classifyCodexMessage', () => {
  it('classifies a plain response (id + result)', () => {
    expect(classifyCodexMessage({ id: 30, result: { turn: { id: 't1' } } })).toEqual({
      kind: 'response',
      id: 30,
      result: { turn: { id: 't1' } },
      error: undefined
    })
  })

  it('classifies an error response (id + error)', () => {
    const c = classifyCodexMessage({ id: 5, error: { code: -32001, message: 'busy' } })
    expect(c).toEqual({
      kind: 'response',
      id: 5,
      result: undefined,
      error: { code: -32001, message: 'busy' }
    })
  })

  it('classifies a server-initiated request (id + method) as an approval gate', () => {
    const c = classifyCodexMessage({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item_1', command: 'rm x' }
    })
    expect(c).toEqual({
      kind: 'serverRequest',
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item_1', command: 'rm x' }
    })
  })

  it('classifies a notification (method, no id)', () => {
    expect(classifyCodexMessage({ method: 'item/agentMessage/delta', params: { delta: 'hi' } })).toEqual({
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { delta: 'hi' }
    })
  })

  it('does not lose id 0 (the initialize request/response id)', () => {
    const c = classifyCodexMessage({ id: 0, result: { userAgent: 'codex' } })
    expect(c?.kind).toBe('response')
    expect((c as Extract<CodexInbound, { kind: 'response' }>).id).toBe(0)
  })

  it('prefers serverRequest when a message carries both id and method', () => {
    const c = classifyCodexMessage({ id: 7, method: 'item/fileChange/requestApproval', params: {} })
    expect(c?.kind).toBe('serverRequest')
  })

  it('returns null for junk (non-object, array, or shapeless)', () => {
    expect(classifyCodexMessage(null)).toBeNull()
    expect(classifyCodexMessage(42)).toBeNull()
    expect(classifyCodexMessage([1, 2])).toBeNull()
    expect(classifyCodexMessage({ foo: 'bar' })).toBeNull()
  })
})

describe('decodeCodexChunk', () => {
  it('decodes and classifies a realistic app-server stream split across chunks', () => {
    const d = new JsonlDecoder()
    // A turn's opening: response to turn/start, then two notifications, with the
    // approval server-request split across the chunk boundary.
    const first = decodeCodexChunk(
      d,
      '{"id":30,"result":{"turn":{"id":"turn_1","status":"inProgress"}}}\n' +
        '{"method":"turn/started","params":{"turn":{"id":"turn_1"}}}\n' +
        '{"id":31,"method":"item/commandExecu'
    )
    expect(first.map((m) => m.kind)).toEqual(['response', 'notification'])
    expect(d.pending).toContain('item/commandExecu')

    const second = decodeCodexChunk(
      d,
      'tion/requestApproval","params":{"itemId":"c1","command":"ls"}}\n' +
        '{"method":"turn/completed","params":{"turn":{"id":"turn_1","status":"completed"}}}\n'
    )
    expect(second.map((m) => m.kind)).toEqual(['serverRequest', 'notification'])
    const gate = second[0] as Extract<CodexInbound, { kind: 'serverRequest' }>
    expect(gate.id).toBe(31)
    expect(gate.method).toBe('item/commandExecution/requestApproval')
  })
})
