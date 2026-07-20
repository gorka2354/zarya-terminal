/* eslint-disable no-control-regex */
// CSI/ESC sequences, OSC strings (BEL or ST terminated), lone controls.
const ANSI_RE = new RegExp(
  [
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?', // OSC ... BEL|ST
    '\\x1b\\[[0-9;?=><]*[0-9A-Za-z@^`{|}~]', // CSI
    '\\x1b[PX_^][^\\x1b]*\\x1b\\\\', // DCS/SOS/PM/APC ... ST
    '\\x1b[()#][0-9A-Za-z]', // charset
    '\\x1b[0-9A-Za-z=><]', // simple ESC
    '[\\x00-\\x08\\x0b-\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f]' // stray controls (keep \t \n \r)
  ].join('|'),
  'g'
)

/** Strip ANSI/VT escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Human-friendly duration: 34ms, 2.4s, 1m 12s, 1h 4m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Relative time: "только что", "5 мин назад", "вчера", or a date. */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 45_000) return 'только что'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} мин назад`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} ч назад`
  if (diff < 172_800_000) return 'вчера'
  return new Date(ts).toLocaleDateString()
}

/** Shorten a path for display: C:\Users\me\proj -> ~\proj (home) or …\tail. */
export function shortenPath(p: string, max = 40): string {
  if (!p) return ''
  let out = p
  const home = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+|\/home\/[^/]+|\/Users\/[^/]+)/.exec(p)
  if (home) out = '~' + p.slice(home[1].length)
  if (out.length <= max) return out
  const sep = out.includes('\\') ? '\\' : '/'
  const parts = out.split(/[\\/]/)
  let tail = parts.pop() ?? ''
  while (parts.length && ('…' + sep + parts[parts.length - 1] + sep + tail).length <= max) {
    tail = parts.pop() + sep + tail
  }
  return '…' + sep + tail
}
