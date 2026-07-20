import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '@shared/types'

/** Max entries kept in memory for search. The file keeps everything. */
const MEM_LIMIT = 20000
/** How much of the tail of history.jsonl to load on boot. */
const LOAD_TAIL_BYTES = 4 * 1024 * 1024

/**
 * Global cross-session command history ("Time Machine").
 * Append-only JSONL on disk; recent tail kept in memory for fuzzy search.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private appendQueue: Promise<void> = Promise.resolve()
  private loaded = false

  private get file() {
    return join(app.getPath('userData'), 'history.jsonl')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const stat = await fs.stat(this.file)
      const start = Math.max(0, stat.size - LOAD_TAIL_BYTES)
      const fh = await fs.open(this.file, 'r')
      const buf = Buffer.alloc(stat.size - start)
      await fh.read(buf, 0, buf.length, start)
      await fh.close()
      const text = buf.toString('utf8')
      const lines = text.slice(text.indexOf('\n') + (start > 0 ? 1 : 0)).split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.entries.push(JSON.parse(line) as HistoryEntry)
        } catch {
          // skip corrupt line
        }
      }
      if (this.entries.length > MEM_LIMIT) {
        this.entries = this.entries.slice(-MEM_LIMIT)
      }
    } catch {
      // no history yet
    }
  }

  async add(entry: HistoryEntry): Promise<void> {
    await this.ensureLoaded()
    const cmd = entry.command.trim()
    if (!cmd) return
    this.entries.push(entry)
    if (this.entries.length > MEM_LIMIT) this.entries.shift()
    this.appendQueue = this.appendQueue
      .catch(() => {})
      .then(() => fs.appendFile(this.file, JSON.stringify(entry) + '\n', 'utf8'))
    await this.appendQueue
  }

  /**
   * Search history. Empty query returns recent unique commands.
   * Matching: every whitespace-separated token must appear in command or cwd.
   */
  async search(query: string, limit = 100): Promise<HistoryEntry[]> {
    await this.ensureLoaded()
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const seen = new Set<string>()
    const out: HistoryEntry[] = []
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i]
      const hay = (e.command + ' ' + e.cwd).toLowerCase()
      if (tokens.every((t) => hay.includes(t))) {
        const key = e.command.trim()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(e)
      }
    }
    return out
  }
}
