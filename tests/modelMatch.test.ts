import { describe, expect, it } from 'vitest'
import type { ClaudeModelInfo } from '@shared/types'
import {
  famOf,
  idParts,
  parseVersion,
  resolveRowValue,
  sameModel,
  shownRows
} from '@/features/ai/modelMatch'

/** Mirrors what `claude --version 2.1.220` actually returns (probed live). */
const LIVE_CATALOG: ClaudeModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
]

describe('idParts / famOf', () => {
  it('splits a version-qualified id', () => {
    expect(idParts('claude-opus-4-8[1m]')).toEqual({ fam: 'opus', ver: '4.8', ctx: true })
  })

  it('reports a floating alias as version-less', () => {
    expect(idParts('opus[1m]')).toEqual({ fam: 'opus', ver: '', ctx: true })
    expect(idParts('sonnet')).toEqual({ fam: 'sonnet', ver: '', ctx: false })
  })

  it('drops a trailing date stamp', () => {
    expect(idParts('claude-haiku-4-5-20251001')).toEqual({ fam: 'haiku', ver: '4.5', ctx: false })
  })

  it('famOf survives every shape', () => {
    expect(famOf('claude-opus-5[1m]')).toBe('opus')
    expect(famOf('opus[1m]')).toBe('opus')
    expect(famOf('')).toBe('')
  })
})

describe('parseVersion', () => {
  it('names the new generation without a code change', () => {
    expect(parseVersion('claude-opus-5[1m]')).toEqual({ name: 'Opus 5', ctx: true })
    expect(parseVersion('claude-opus-4-8[1m]')).toEqual({ name: 'Opus 4.8', ctx: true })
    expect(parseVersion('claude-sonnet-6-2')).toEqual({ name: 'Sonnet 6.2', ctx: false })
  })

  it('leaves a bare alias unversioned rather than inventing one', () => {
    expect(parseVersion('opus[1m]')).toEqual({ name: 'Opus', ctx: true })
  })

  it('strips the haiku date stamp', () => {
    expect(parseVersion('claude-haiku-4-5-20251001').name).toBe('Haiku 4.5')
  })
})

describe('sameModel', () => {
  it('does NOT equate two generations of one family (the Opus 5 regression)', () => {
    expect(sameModel('claude-opus-4-8[1m]', 'claude-opus-5[1m]')).toBe(false)
    expect(sameModel('claude-fable-5[1m]', 'claude-fable-6[1m]')).toBe(false)
  })

  it('matches a floating alias to whatever it resolves to', () => {
    expect(sameModel('opus[1m]', 'claude-opus-5[1m]')).toBe(true)
    expect(sameModel('sonnet', 'claude-sonnet-5')).toBe(true)
    expect(sameModel('haiku', 'claude-haiku-4-5-20251001')).toBe(true)
  })

  it('distinguishes the 1M variant when both sides are version-qualified', () => {
    expect(sameModel('claude-opus-5', 'claude-opus-5[1m]')).toBe(false)
    expect(sameModel('claude-opus-5[1m]', 'claude-opus-5[1m]')).toBe(true)
  })

  it('never matches across families', () => {
    expect(sameModel('claude-opus-5', 'claude-sonnet-5')).toBe(false)
  })

  it('treats empty input as no match', () => {
    expect(sameModel('', 'claude-opus-5')).toBe(false)
    expect(sameModel('claude-opus-5', '')).toBe(false)
  })
})

describe('shownRows', () => {
  it("drops the account 'default' pointer and blank values", () => {
    const shown = shownRows(LIVE_CATALOG)
    expect(shown.map((m) => m.value)).toEqual([
      'opus[1m]',
      'claude-fable-5[1m]',
      'sonnet',
      'haiku'
    ])
  })
})

describe('resolveRowValue', () => {
  const shown = shownRows(LIVE_CATALOG)

  it("unpinned + Opus 5 running lights up the Opus row, not the hidden 'default'", () => {
    expect(resolveRowValue(shown, '', 'claude-opus-5[1m]')).toBe('opus[1m]')
  })

  it('unpinned + nothing running selects nothing', () => {
    expect(resolveRowValue(shown, '', '')).toBe('')
  })

  it('unpinned prefers an exact resolvedModel hit over a family hit', () => {
    const twoOpus: ClaudeModelInfo[] = [
      { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus' },
      { value: 'claude-opus-5[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus 5' }
    ]
    expect(resolveRowValue(twoOpus, '', 'claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
  })

  it('an alias pin lands on its own row (survives the model behind it changing)', () => {
    expect(resolveRowValue(shown, 'opus[1m]', 'claude-opus-5[1m]')).toBe('opus[1m]')
  })

  it('a pin no longer in the catalog selects NO row, so the caller can flag it', () => {
    const renamed: ClaudeModelInfo[] = [
      { value: 'claude-fable-6[1m]', resolvedModel: 'claude-fable-6', displayName: 'Fable' }
    ]
    // Returns the pin itself — no catalog row claims it, so nothing lights up.
    const got = resolveRowValue(renamed, 'claude-fable-5[1m]', '')
    expect(got).toBe('claude-fable-5[1m]')
    expect(renamed.some((m) => m.value === got)).toBe(false)
  })

  it('still resolves a legacy pin that only differs by alias spelling', () => {
    expect(resolveRowValue(shown, 'sonnet', '')).toBe('sonnet')
  })
})
