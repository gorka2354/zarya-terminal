import { getSettings } from '@/state/settingsStore'
import { runAction } from '@/lib/actionRegistry'

/** Normalize a KeyboardEvent to a chord string like "Ctrl+Shift+P". */
export function chordFromEvent(e: KeyboardEvent): string | null {
  const key = e.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  let k = key
  if (k === ' ') k = 'Space'
  else if (k.length === 1) {
    k = k.toUpperCase()
    // Non-latin keyboard layouts (e.g. Cyrillic): "Ctrl+Shift+Ц" would never
    // match a "Ctrl+Shift+W" binding — fall back to the physical key code.
    if (!/[A-Z0-9]/.test(k)) {
      const code = e.code
      if (/^Key[A-Z]$/.test(code)) k = code.slice(3)
      else if (/^Digit[0-9]$/.test(code)) k = code.slice(5)
    }
  }
  parts.push(k)
  return parts.join('+')
}

/** Pretty-print a chord for UI (⌃⇧P style is skipped — Windows-first app). */
export function formatChord(chord: string): string {
  return chord.replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→')
}

function findActionForChord(chord: string): string | null {
  const bindings = getSettings().keybindings
  for (const [actionId, bound] of Object.entries(bindings)) {
    if (bound === chord) return actionId
  }
  return null
}

/**
 * True when the event matches a global keybinding — the terminal must not
 * swallow it (XtermView returns false from its custom key handler).
 */
export function shouldBypassTerminal(e: KeyboardEvent): boolean {
  const chord = chordFromEvent(e)
  if (!chord) return false
  if (chord === 'F12') return true
  return findActionForChord(chord) !== null
}

let initialized = false

// App-level actions that must stay reachable even while a Monaco editor has
// focus (e.g. opening the command palette from inside a file). Everything
// else falls through to Monaco's own keybindings (Ctrl+Shift+K delete line,
// Ctrl+Up/Down, Ctrl+Shift+O, etc.) instead of being swallowed globally.
const MONACO_ALLOWLIST = new Set([
  'app.command-palette',
  'app.quick-open',
  'app.settings',
  'app.toggle-ai-panel',
  'app.toggle-sidebar'
])

/** Global keydown dispatcher: chord -> action. Call once at boot. */
export function initKeybindings(): void {
  if (initialized) return
  initialized = true
  window.addEventListener(
    'keydown',
    (e) => {
      const chord = chordFromEvent(e)
      if (!chord) return
      if (chord === 'F12') {
        e.preventDefault()
        window.zarya.app.windowCommand('devtools')
        return
      }
      const actionId = findActionForChord(chord)
      if (!actionId) return
      // Let typing in inputs win over single-modifier bindings.
      const target = e.target as HTMLElement | null
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      const isXtermInput = target?.classList.contains('xterm-helper-textarea')
      if (inInput && !isXtermInput && !e.ctrlKey && !e.altKey && !e.metaKey) return
      // Inside the Monaco editor, only app-level actions bypass it — everything
      // else must reach Monaco's own keybindings unmolested.
      const inMonaco = target?.closest('.monaco-editor')
      if (inMonaco && !MONACO_ALLOWLIST.has(actionId)) return
      e.preventDefault()
      e.stopPropagation()
      runAction(actionId)
    },
    { capture: true }
  )
}
