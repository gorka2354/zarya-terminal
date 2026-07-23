/**
 * Tiny registry of "flush before quit" callbacks. Lets the AI store persist its
 * conversations during the sessions store's prepareQuit flow without a circular
 * import (both sides depend on this leaf module, not on each other).
 */
type FlushFn = () => Promise<void> | void

const flushers: FlushFn[] = []

export function onQuitFlush(fn: FlushFn): void {
  flushers.push(fn)
}

export async function runQuitFlushers(): Promise<void> {
  await Promise.all(
    flushers.map(async (fn) => {
      try {
        await fn()
      } catch {
        // best-effort — never block quit on a flush error
      }
    })
  )
}
