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

/**
 * Сколько раз для сессии создавали терминал. Одна панель — один терминал на всю
 * жизнь сессии: второе создание означает, что панель перемонтировали, а вместе с
 * ней потеряли всё, что человек видел на экране. Счётчик читают прогоны — глазами
 * такую потерю замечают уже после того, как она случилась.
 */
const creations = new Map<string, number>()

export function registerTerminal(sessionId: string, handle: TermHandle): void {
  creations.set(sessionId, (creations.get(sessionId) ?? 0) + 1)
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

/**
 * Человек тянет разделитель прямо сейчас.
 *
 * Пока он тянет, размеры панелей меняются каждый кадр, и каждый пересчёт
 * уходил в оболочку: `fit` перекладывает буфер xterm под новую ширину, а
 * `pty.resize` — это ConPTY, то есть перерисовка настоящей консоли в главном
 * процессе. Умножаем на четыре панели и на частоту мыши (а она бывает и 1000
 * Гц) — и жест, который должен быть мгновенным, начинает спотыкаться.
 *
 * Промежуточные размеры оболочке не нужны: ей важен тот, на котором отпустили.
 * Поэтому на время жеста пересчёт откладывается, а по отпусканию делается один
 * раз — для всех живых терминалов.
 */
let layoutDragging = false

export function isLayoutDragging(): boolean {
  return layoutDragging
}

export function setLayoutDragging(on: boolean): void {
  if (layoutDragging === on) return
  layoutDragging = on
  if (on) return
  for (const h of handles.values()) {
    try {
      h.fit()
    } catch {
      // размер посчитается со следующим наблюдением
    }
  }
}

export function disposeTerminal(sessionId: string): void {
  const h = handles.get(sessionId)
  handles.delete(sessionId)
  buffers.delete(sessionId)
  pendingRestore.delete(sessionId)
  creations.delete(sessionId)
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

/**
 * Прогонам: написать прямо в терминал, минуя pty. Так проверяется, что при
 * перестройке раскладки экран панели ОСТАЛСЯ тем же: метку, которой оболочка
 * никогда не присылала, новый терминал показать не может.
 */
;(
  window as unknown as { __zaryaTermWrite?: (sessionId: string, text: string) => void }
).__zaryaTermWrite = (sessionId, text) => handles.get(sessionId)?.term.write(text)

// Прогонам: сколько раз создавали терминал каждой сессии. Больше одного — панель
// перемонтировали, и то, что было на экране, человек уже не увидит.
;(
  window as unknown as { __zaryaTermCreations?: () => Record<string, number> }
).__zaryaTermCreations = () => Object.fromEntries(creations)

// QA hook: the live xterm option bag of the first registered terminal, so a
// harness can verify that a settings change actually reached the terminal.
;(window as unknown as { __zaryaTermOptions?: () => unknown }).__zaryaTermOptions = () => {
  const first = handles.values().next().value as TermHandle | undefined
  if (!first) return null
  const o = first.term.options
  return { fontSize: o.fontSize, fontFamily: o.fontFamily, lineHeight: o.lineHeight }
}
