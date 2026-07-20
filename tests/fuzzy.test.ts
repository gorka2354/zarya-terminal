import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from '@/lib/fuzzy'

describe('fuzzyScore', () => {
  it('scores an earlier substring match higher than a later one', () => {
    const early = fuzzyScore('term', 'terminal.split-right')
    const late = fuzzyScore('term', 'open-external-terminal')
    expect(early).toBeGreaterThan(late)
  })

  it('gives a bonus for matches at a word start', () => {
    // 's' at the very start of the string vs 's' buried mid-word (subsequence path).
    const wordStart = fuzzyScore('sr', 'split-right')
    const midWord = fuzzyScore('sr', 'terminal search')
    expect(wordStart).toBeGreaterThan(-Infinity)
    expect(midWord).toBeGreaterThan(-Infinity)
    expect(wordStart).toBeGreaterThan(midWord)
  })

  it('returns -Infinity when the query does not match as a subsequence', () => {
    expect(fuzzyScore('xyz', 'terminal.split-right')).toBe(-Infinity)
  })

  it('returns 0 for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('TERM', 'terminal')).toBeGreaterThan(-Infinity)
  })
})

describe('fuzzyFilter', () => {
  interface Item {
    id: string
    label: string
  }
  const items: Item[] = [
    { id: '1', label: 'Split terminal right' },
    { id: '2', label: 'Split terminal down' },
    { id: '3', label: 'Close tab' },
    { id: '4', label: 'Open settings' }
  ]

  it('returns items unchanged (up to limit) for an empty query', () => {
    expect(fuzzyFilter('', items, (i) => i.label)).toEqual(items)
    expect(fuzzyFilter('   ', items, (i) => i.label)).toEqual(items)
  })

  it('filters out non-matching items, keeping only substring matches', () => {
    const result = fuzzyFilter('split', items, (i) => i.label)
    expect(result.map((r) => r.id).sort()).toEqual(['1', '2'])
  })

  it('excludes items with no subsequence match at all', () => {
    const result = fuzzyFilter('zzz', items, (i) => i.label)
    expect(result).toEqual([])
  })

  it('ranks an earlier substring match above a later one', () => {
    const ranked: Item[] = [
      { id: 'later', label: 'reopen close tab' },
      { id: 'earlier', label: 'close tab now' }
    ]
    const result = fuzzyFilter('close', ranked, (i) => i.label)
    expect(result.map((r) => r.id)).toEqual(['earlier', 'later'])
  })

  it('respects the limit parameter', () => {
    const result = fuzzyFilter('e', items, (i) => i.label, 1)
    expect(result.length).toBe(1)
  })
})
