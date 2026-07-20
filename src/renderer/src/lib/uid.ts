/** Short collision-resistant id (no external dep). */
export function uid(prefix = ''): string {
  const rnd = crypto.getRandomValues(new Uint8Array(9))
  let s = ''
  for (const b of rnd) s += (b % 36).toString(36)
  return `${prefix}${Date.now().toString(36)}${s}`
}
