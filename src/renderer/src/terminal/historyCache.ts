/**
 * In-memory MRU of recent commands feeding ghost-text autosuggest.
 * Seeded from the persistent global history on boot.
 */
const recent: string[] = []
const MAX = 500
let seeded = false

export async function seedHistoryCache(): Promise<void> {
  if (seeded) return
  seeded = true
  try {
    const entries = await window.zarya.history.search('', 300)
    for (const e of entries) {
      if (!recent.includes(e.command)) recent.push(e.command)
    }
  } catch {
    // history is optional
  }
}

export function pushRecentCommand(command: string): void {
  const cmd = command.trim()
  if (!cmd) return
  const i = recent.indexOf(cmd)
  if (i >= 0) recent.splice(i, 1)
  recent.unshift(cmd)
  if (recent.length > MAX) recent.pop()
}

/** First history command extending `prefix` (already-typed text). */
export function suggestFor(prefix: string): string | null {
  if (prefix.length < 2) return null
  for (const cmd of recent) {
    if (cmd.length > prefix.length && cmd.startsWith(prefix)) return cmd
  }
  const lower = prefix.toLowerCase()
  for (const cmd of recent) {
    if (cmd.length > prefix.length && cmd.toLowerCase().startsWith(lower)) return cmd
  }
  return null
}
