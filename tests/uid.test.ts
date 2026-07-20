import { describe, expect, it } from 'vitest'
import { uid } from '@/lib/uid'

describe('uid', () => {
  it('generates 1000 unique ids', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(uid())
    expect(ids.size).toBe(1000)
  })

  it('prefixes the id when a prefix is given', () => {
    const id = uid('blk_')
    expect(id.startsWith('blk_')).toBe(true)
  })

  it('has no prefix by default', () => {
    const id = uid()
    // Base36 alphabet only: digits and lowercase letters.
    expect(/^[0-9a-z]+$/.test(id)).toBe(true)
  })

  it('produces different values across distinct prefixes too', () => {
    const a = uid('a_')
    const b = uid('b_')
    expect(a).not.toBe(b)
  })
})
