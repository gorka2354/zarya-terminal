import { describe, expect, it } from 'vitest'
import { pickOptionId, type AcpPermissionOption } from '../src/main/acpProtocol'

const OPTS: AcpPermissionOption[] = [
  { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  { optionId: 'r2', name: 'Always reject', kind: 'reject_always' }
]

describe('pickOptionId', () => {
  it('allow → the allow_once option (opaque id echoed, not hardcoded)', () => {
    expect(pickOptionId(OPTS, true)).toBe('a1')
  })

  it('deny → the reject_once option', () => {
    expect(pickOptionId(OPTS, false)).toBe('r1')
  })

  it('prefers once over always', () => {
    expect(pickOptionId(OPTS, true)).toBe('a1')
    expect(pickOptionId(OPTS, false)).toBe('r1')
  })

  it('falls back to always when once is absent', () => {
    const noOnce = OPTS.filter((o) => !o.kind?.endsWith('_once'))
    expect(pickOptionId(noOnce, true)).toBe('a2')
    expect(pickOptionId(noOnce, false)).toBe('r2')
  })

  it('fails closed: no matching kind → undefined (driver answers cancelled)', () => {
    const onlyAllow = OPTS.filter((o) => o.kind?.startsWith('allow'))
    // A deny with no reject option must NOT accidentally select an allow option.
    expect(pickOptionId(onlyAllow, false)).toBeUndefined()
    const onlyReject = OPTS.filter((o) => o.kind?.startsWith('reject'))
    expect(pickOptionId(onlyReject, true)).toBeUndefined()
  })

  it('empty options → undefined', () => {
    expect(pickOptionId([], true)).toBeUndefined()
    expect(pickOptionId([], false)).toBeUndefined()
  })
})
