export interface PathMatch {
  /** 1-based start column. */
  start: number
  /** 1-based end column (inclusive). */
  end: number
  path: string
  line?: number
}

// Absolute windows (C:\...), unix (/...), relative (./ ../), home (~/)
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/(?!\/))[\w\-. ~+@()\\/]*[\w\-+@)/\\]/g

/** Find file-ish paths in a rendered terminal line. */
export function findPathsInLine(text: string): PathMatch[] {
  const out: PathMatch[] = []
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_RE.exec(text))) {
    let raw = m[0]
    // Trim trailing punctuation that's usually sentence context.
    raw = raw.replace(/[).,;'"]+$/, '')
    if (raw.length < 3) continue
    // Optional :line(:col) suffix immediately after the match
    const rest = text.slice(m.index + raw.length)
    let line: number | undefined
    let extra = 0
    const lm = /^:(\d+)(?::\d+)?/.exec(rest)
    if (lm) {
      line = parseInt(lm[1], 10)
      extra = lm[0].length
    }
    out.push({
      start: m.index + 1,
      end: m.index + raw.length + extra,
      path: raw,
      line
    })
  }
  return out
}

/** Resolve a possibly-relative path against a cwd (no fs access). */
export function resolveAgainstCwd(path: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return path
  if (path.startsWith('~')) return path // handled by caller if needed
  const sep = cwd.includes('\\') ? '\\' : '/'
  const parts = [...cwd.split(/[\\/]/), ...path.split(/[\\/]/)]
  const stack: string[] = []
  for (const p of parts) {
    if (p === '' && stack.length) continue
    if (p === '.') continue
    if (p === '..') {
      stack.pop()
      continue
    }
    stack.push(p)
  }
  return stack.join(sep)
}
