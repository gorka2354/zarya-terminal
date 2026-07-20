import { describe, expect, it } from 'vitest'
import { mergeDeep } from '../src/main/jsonStore'

describe('mergeDeep', () => {
  it('merges nested objects field by field', () => {
    const base = { a: 1, nested: { x: 1, y: 2 } }
    const patch = { nested: { y: 20, z: 30 } }
    expect(mergeDeep(base, patch)).toEqual({ a: 1, nested: { x: 1, y: 20, z: 30 } })
  })

  it('replaces arrays wholesale instead of merging elements', () => {
    const base = { list: [1, 2, 3] }
    const patch = { list: [9] }
    expect(mergeDeep(base, patch)).toEqual({ list: [9] })
  })

  it('overwrites with null', () => {
    const base = { a: { b: 1 } }
    const patch = { a: null }
    expect(mergeDeep(base, patch)).toEqual({ a: null })
  })

  it('overwrites an object field with a primitive', () => {
    const base = { a: { b: 1 } }
    const patch = { a: 'gone' }
    expect(mergeDeep(base, patch)).toEqual({ a: 'gone' })
  })

  it('leaves base unchanged when the patch is undefined', () => {
    const base = { a: 1, b: { c: 2 } }
    expect(mergeDeep(base, undefined)).toBe(base)
  })

  it('does not mutate the original base object', () => {
    const base = { a: 1, nested: { x: 1 } }
    const patch = { nested: { x: 2 } }
    mergeDeep(base, patch)
    expect(base).toEqual({ a: 1, nested: { x: 1 } })
  })
})
