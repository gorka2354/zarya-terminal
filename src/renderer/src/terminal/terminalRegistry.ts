import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import type { BlockEngine } from './blockEngine'

/**
 * Non-react registry of live terminal instances.
 * PTY data arriving before the view mounts is buffered and flushed on register.
 */
export interface TermHandle {
  term: Terminal
  engine: BlockEngine
  search: SearchAddon
  write: (data: string) => void
  serialize: (maxLines: number) => string
  fit: () => void
  focus: () => void
  dispose: () => void
}

const handles = new Map<string, TermHandle>()
const buffers = new Map<string, string[]>()
const pendingRestore = new Map<string, string>()

let exitCallback: ((sessionId: string, exitCode: number) => void) | null = null
let wired = false

/** Subscribe to pty events exactly once (App boot). */
export function wirePtyEvents(): void {
  if (wired) return
  wired = true
  window.zarya.pty.onData((sessionId, data) => {
    const h = handles.get(sessionId)
    if (h) {
      h.write(data)
    } else {
      let buf = buffers.get(sessionId)
      if (!buf) {
        buf = []
        buffers.set(sessionId, buf)
      }
      buf.push(data)
      // Guard against unbounded growth if a view never mounts.
      if (buf.length > 2000) buf.splice(0, buf.length - 2000)
    }
  })
  window.zarya.pty.onExit((sessionId, exitCode) => {
    exitCallback?.(sessionId, exitCode)
  })
}

export function onPtyExit(cb: (sessionId: string, exitCode: number) => void): void {
  exitCallback = cb
}

export function registerTerminal(sessionId: string, handle: TermHandle): void {
  handles.set(sessionId, handle)
  const buf = buffers.get(sessionId)
  if (buf) {
    buffers.delete(sessionId)
    for (const chunk of buf) handle.write(chunk)
  }
}

export function getTerminal(sessionId: string): TermHandle | undefined {
  return handles.get(sessionId)
}

export function disposeTerminal(sessionId: string): void {
  const h = handles.get(sessionId)
  handles.delete(sessionId)
  buffers.delete(sessionId)
  pendingRestore.delete(sessionId)
  try {
    h?.dispose()
  } catch {
    // already disposed
  }
}

/** Scrollback waiting to be replayed into a restored session's terminal. */
export function setPendingRestore(sessionId: string, scrollback: string): void {
  pendingRestore.set(sessionId, scrollback)
}

export function takePendingRestore(sessionId: string): string | undefined {
  const s = pendingRestore.get(sessionId)
  pendingRestore.delete(sessionId)
  return s
}

export function peekPendingRestore(sessionId: string): string | undefined {
  return pendingRestore.get(sessionId)
}
