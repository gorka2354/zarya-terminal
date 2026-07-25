import type { AppearanceSettings } from '@shared/types'

/**
 * The xterm options Zarya derives from user settings. Kept as a plain shape
 * (no `@xterm/xterm` import) so it's trivially unit-testable and node-safe.
 */
export interface DerivedTerminalOptions {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
}

/**
 * Single source of truth for settings → xterm options. Both the initial
 * `new Terminal(...)` and the live settings-change effect go through here, so a
 * newly added appearance setting can't apply on boot yet silently fail to
 * update live (or vice-versa). Terminal padding is intentionally NOT here — it
 * is CSS on the wrapper, not an xterm option.
 */
export function terminalOptionsFrom(
  appearance: AppearanceSettings,
  scrollback: number
): DerivedTerminalOptions {
  return {
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    lineHeight: appearance.lineHeight,
    cursorStyle: appearance.cursorStyle,
    cursorBlink: appearance.cursorBlink,
    scrollback
  }
}

/** A live terminal's mutable options bag — the sliver we write to. */
type TerminalOptionsTarget = {
  options: Partial<Record<keyof DerivedTerminalOptions, unknown>>
}

/**
 * Apply the derived options onto a live terminal (settings-change effect).
 * Assigns field-by-field so each xterm option setter fires. Returns the options
 * it wrote, so callers/tests can assert without reaching into the terminal.
 */
export function applyTerminalOptions(
  term: TerminalOptionsTarget,
  appearance: AppearanceSettings,
  scrollback: number
): DerivedTerminalOptions {
  const o = terminalOptionsFrom(appearance, scrollback)
  term.options.fontFamily = o.fontFamily
  term.options.fontSize = o.fontSize
  term.options.lineHeight = o.lineHeight
  term.options.cursorStyle = o.cursorStyle
  term.options.cursorBlink = o.cursorBlink
  term.options.scrollback = o.scrollback
  return o
}
