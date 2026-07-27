import { describe, expect, it } from 'vitest'
import { hasAllowOnce, pickOptionId, type AcpPermissionOption } from '../src/main/acpProtocol'

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

  /**
   * SECURITY: разрешение не повышается само. «ВЫПОЛНИТЬ» означает один запуск;
   * если у гейта есть только `allow_always`, тихо выбрать его — значит выдать
   * разрешение на всю сессию за спиной человека, да ещё и заставить агента
   * перестать спрашивать. Гейт, который отменяет сам себя, хуже отсутствующего:
   * он оставляет уверенность, что спросят и в следующий раз.
   */
  it('НЕ повышает разовое разрешение до постоянного', () => {
    const noOnce = OPTS.filter((o) => !o.kind?.endsWith('_once'))
    expect(pickOptionId(noOnce, true)).toBeUndefined()
  })

  it('выбирает «всегда» только по явному согласию', () => {
    const noOnce = OPTS.filter((o) => !o.kind?.endsWith('_once'))
    expect(pickOptionId(noOnce, true, true)).toBe('a2')
  })

  it('согласие на «всегда» не меняет выбор, когда разовое есть', () => {
    // Человек согласился на «всегда» — но раз разовый вариант существует, гейт
    // остаётся разовым: минимальное из достаточного.
    expect(pickOptionId(OPTS, true, true)).toBe('a1')
  })

  it('отказ повышается свободно: «всегда отклонять» строже разового', () => {
    const noOnce = OPTS.filter((o) => !o.kind?.endsWith('_once'))
    expect(pickOptionId(noOnce, false)).toBe('r2')
  })

  it('hasAllowOnce отличает гейт с разовым разрешением от гейта без него', () => {
    expect(hasAllowOnce(OPTS)).toBe(true)
    expect(hasAllowOnce(OPTS.filter((o) => !o.kind?.endsWith('_once')))).toBe(false)
    expect(hasAllowOnce([])).toBe(false)
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
