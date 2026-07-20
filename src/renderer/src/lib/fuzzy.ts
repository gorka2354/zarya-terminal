/**
 * Small fuzzy matcher used by the palette, quick-open and history search.
 * Returns a score (higher = better) or -Infinity when not matching.
 * Matching is subsequence-based with bonuses for word starts and runs.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // Fast path: substring match scores high, earlier is better.
  const sub = t.indexOf(q)
  if (sub >= 0) {
    return 1000 - sub - (t.length - q.length) * 0.1 + (sub === 0 ? 200 : 0)
  }

  let qi = 0
  let score = 0
  let run = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++
      run++
      score += 10 + run * 2
      const prev = t[ti - 1]
      if (ti === 0 || prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.') {
        score += 15 // word-start bonus
      }
    } else {
      run = 0
      score -= 0.5
    }
  }
  if (qi < q.length) return -Infinity
  return score - (t.length - q.length) * 0.05
}

export interface FuzzyResult<T> {
  item: T
  score: number
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit = 50
): T[] {
  if (!query.trim()) return items.slice(0, limit)
  const results: FuzzyResult<T>[] = []
  for (const item of items) {
    const s = fuzzyScore(query, key(item))
    if (s > -Infinity) results.push({ item, score: s })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit).map((r) => r.item)
}
