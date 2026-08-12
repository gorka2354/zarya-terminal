import type { ClaudeModelInfo } from '@shared/types'

/**
 * Model-identity rules for the launch console.
 *
 * Claude ids come in two flavours that must not be confused: floating aliases
 * ('opus[1m]', 'sonnet') that the CLI re-points at every release, and
 * version-qualified ids ('claude-opus-4-8[1m]', 'claude-fable-5[1m]') that name
 * one exact model. Comparing them by family alone — which is what this used to
 * do — makes a new generation look identical to the old one, so the console lit
 * up "Opus 5 · активна" while still launching the pinned 4.8.
 *
 * Extracted from the component so the rules are unit-testable.
 */

/**
 * Split any model id/alias/resolved id into its comparable parts:
 * 'claude-opus-4-8[1m]' -> { fam: 'opus', ver: '4.8', ctx: true };
 * 'opus[1m]' -> { fam: 'opus', ver: '', ctx: true }.
 */
export function idParts(id: string): { fam: string; ver: string; ctx: boolean } {
  const ctx = /\[1m\]/i.test(id)
  const s = id
    .replace(/^claude-/, '')
    .replace(/\[1m\]/i, '')
    .replace(/-\d{6,}$/, '') // trailing date stamp (haiku)
  const parts = s.split(/[-\s]/)
  return {
    fam: (parts[0] ?? '').toLowerCase(),
    ver: parts
      .slice(1)
      .filter((p) => /^\d+$/.test(p))
      .join('.'),
    ctx
  }
}

/** Family word from any model id/alias/resolved id ('claude-opus-4-8[1m]' -> 'opus'). */
export function famOf(id: string): string {
  return idParts(id).fam
}

/**
 * Parse a version-qualified display name out of a model id: 'claude-opus-4-8[1m]'
 * -> { name: 'Opus 4.8', ctx: true }; 'sonnet' -> { name: 'Sonnet' }. Future-proof:
 * a new 'claude-sonnet-6-2' becomes 'Sonnet 6.2' with no code change.
 */
export function parseVersion(id: string): { name: string; ctx: boolean } {
  const { fam, ver, ctx } = idParts(id)
  const F = fam.charAt(0).toUpperCase() + fam.slice(1)
  return { name: ver ? `${F} ${ver}` : F, ctx }
}

/**
 * Two ids refer to the same Claude model. When BOTH name a version, the version
 * and the 1M variant must agree — otherwise a stale pin would silently attach
 * itself to the next generation's row. When either side is a bare alias it has
 * no version to compare and floats to whatever the CLI resolves, so family is
 * all we can (and should) match on.
 */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const x = idParts(a)
  const y = idParts(b)
  if (x.fam !== y.fam) return false
  if (!x.ver || !y.ver) return true
  return x.ver === y.ver && x.ctx === y.ctx
}

/**
 * The catalog rows the console actually renders. The account 'default' entry is
 * a pointer at another model, not a model of its own — leaving it in the pool
 * made the unpinned resolve land on a row that is never rendered, so no row lit
 * up at all while a model was plainly running.
 */
export function shownRows(catalog: ClaudeModelInfo[]): ClaudeModelInfo[] {
  return catalog.filter((m) => m.value !== '' && famOf(m.value) !== 'default')
}

/**
 * Which rendered row a pin lands on. Returns '' when nothing matches, so the
 * caller can surface a stale pin as its own row instead of quietly lighting up
 * someone else's. With no pin we follow the model actually running, exact match
 * first so two rows of one family can't steal each other's marker.
 */
export function resolveRowValue(shown: ClaudeModelInfo[], pin: string, runningId: string): string {
  if (!pin) {
    return (
      shown.find((m) => (m.resolvedModel || m.value) === runningId)?.value ??
      shown.find((m) => sameModel(m.resolvedModel || m.value, runningId))?.value ??
      ''
    )
  }
  return (
    shown.find((m) => m.value === pin)?.value ??
    shown.find((m) => sameModel(m.value, pin))?.value ??
    pin
  )
}
