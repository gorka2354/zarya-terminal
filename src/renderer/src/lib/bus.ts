/** Tiny typed event bus for cross-feature signals. */

export interface BusEvents {
  'block:finished': { sessionId: string; blockId: string; exitCode?: number }
  'terminal:cwd-changed': { sessionId: string; cwd: string }
  'terminal:focus': { sessionId: string }
  'editor:file-saved': { path: string }
  'session:restored': { sessionId: string }
}

type Handler<T> = (payload: T) => void

const handlers = new Map<string, Set<Handler<never>>>()

export function onBus<K extends keyof BusEvents>(
  event: K,
  handler: Handler<BusEvents[K]>
): () => void {
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  set.add(handler as Handler<never>)
  return () => set?.delete(handler as Handler<never>)
}

export function emitBus<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
  handlers.get(event)?.forEach((h) => {
    try {
      ;(h as Handler<BusEvents[K]>)(payload)
    } catch (e) {
      console.error(`bus handler for ${event} failed`, e)
    }
  })
}
