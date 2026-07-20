import { promises as fs } from 'fs'
import { dirname } from 'path'

/** Read a JSON file, returning `fallback` when missing or corrupt. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const writeQueues = new Map<string, Promise<void>>()

/**
 * Atomic JSON write: write to a temp file, then rename over the target.
 * Writes to the same path are serialized so concurrent saves can't interleave.
 */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await fs.rename(tmp, file)
    })
  writeQueues.set(file, next)
  return next
}

/** Deep merge `patch` into `base`. Arrays and non-object leaves are replaced. */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof patch !== 'object' ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: NodeJS.Timeout | undefined
  const wrapped = (...args: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  wrapped.flush = (...args: A) => {
    clearTimeout(t)
    fn(...args)
  }
  return wrapped
}
