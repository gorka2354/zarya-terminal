import { describe, expect, it } from 'vitest'
import type { AppearanceSettings } from '@shared/types'
import { terminalOptionsFrom, applyTerminalOptions } from '@/terminal/terminalOptions'

const APPEARANCE: AppearanceSettings = {
  themeId: 'dawn',
  fontFamily: "'JetBrains Mono', 'Cascadia Mono', monospace",
  fontSize: 20,
  lineHeight: 1.35,
  cursorStyle: 'bar',
  cursorBlink: true,
  terminalPadding: 14,
  windowOpacity: 1,
  acrylic: false,
  uiDensity: 'cozy'
}

describe('terminalOptionsFrom', () => {
  it('maps every appearance field the terminal actually renders', () => {
    expect(terminalOptionsFrom(APPEARANCE, 5000)).toEqual({
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', monospace",
      fontSize: 20,
      lineHeight: 1.35,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 5000
    })
  })

  it('threads scrollback from terminal settings, not appearance', () => {
    expect(terminalOptionsFrom(APPEARANCE, 99).scrollback).toBe(99)
  })

  it('keeps terminalPadding OUT of xterm options (padding is CSS on the wrapper)', () => {
    expect('terminalPadding' in terminalOptionsFrom(APPEARANCE, 1)).toBe(false)
  })

  it('reflects changed font size / cursor style / blink', () => {
    const o = terminalOptionsFrom(
      { ...APPEARANCE, fontSize: 12, cursorStyle: 'block', cursorBlink: false },
      1
    )
    expect(o.fontSize).toBe(12)
    expect(o.cursorStyle).toBe('block')
    expect(o.cursorBlink).toBe(false)
  })
})

describe('applyTerminalOptions', () => {
  it('writes all six options onto a live terminal (init + settings effect share this)', () => {
    const term = { options: {} as Record<string, unknown> }
    applyTerminalOptions(term, APPEARANCE, 3000)
    expect(term.options).toEqual({
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', monospace",
      fontSize: 20,
      lineHeight: 1.35,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 3000
    })
  })

  it('overwrites stale options on a live settings change', () => {
    const term = { options: { fontSize: 20, cursorStyle: 'bar', cursorBlink: true } }
    applyTerminalOptions(
      term,
      { ...APPEARANCE, fontSize: 9, cursorStyle: 'underline', cursorBlink: false },
      3000
    )
    expect(term.options.fontSize).toBe(9)
    expect(term.options.cursorStyle).toBe('underline')
    expect(term.options.cursorBlink).toBe(false)
  })

  it('returns exactly the options it wrote', () => {
    const term = { options: {} as Record<string, unknown> }
    const ret = applyTerminalOptions(term, APPEARANCE, 1000)
    expect(ret).toEqual(term.options)
  })
})
