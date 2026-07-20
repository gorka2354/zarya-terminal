import { describe, expect, it } from 'vitest'
import { formatDuration, shortenPath, stripAnsi } from '@/lib/ansi'

describe('stripAnsi', () => {
  it('strips CSI color/SGR sequences', () => {
    const s = '\x1b[31mred\x1b[0m normal \x1b[1;32mgreen\x1b[m'
    expect(stripAnsi(s)).toBe('red normal green')
  })

  it('strips OSC sequences terminated by BEL', () => {
    const s = '\x1b]0;window title\x07visible text'
    expect(stripAnsi(s)).toBe('visible text')
  })

  it('strips OSC sequences terminated by ST (ESC \\)', () => {
    const s = '\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\'
    expect(stripAnsi(s)).toBe('link text')
  })

  it('strips cursor-movement CSI sequences', () => {
    const s = '\x1b[2J\x1b[H\x1b[1;1Hhello\x1b[3B'
    expect(stripAnsi(s)).toBe('hello')
  })

  it('preserves tabs and newlines while stripping stray control chars', () => {
    const s = 'a\tb\nc\x00\x1fd'
    expect(stripAnsi(s)).toBe('a\tb\ncd')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here')
  })
})

describe('formatDuration', () => {
  it('formats sub-second durations as milliseconds', () => {
    expect(formatDuration(34)).toBe('34ms')
    expect(formatDuration(0)).toBe('0ms')
  })

  it('formats durations under a minute as seconds with one decimal', () => {
    expect(formatDuration(2400)).toBe('2.4s')
    expect(formatDuration(59_000)).toBe('59.0s')
  })

  it('formats durations under an hour as minutes and seconds', () => {
    expect(formatDuration(72_000)).toBe('1m 12s')
    expect(formatDuration(60_000)).toBe('1m')
  })

  it('formats durations of an hour or more as hours and minutes', () => {
    expect(formatDuration(3_600_000 + 4 * 60_000)).toBe('1h 4m')
  })
})

describe('shortenPath', () => {
  it('replaces the windows home directory with ~', () => {
    expect(shortenPath('C:\\Users\\me\\proj')).toBe('~\\proj')
  })

  it('replaces the unix home directory with ~', () => {
    expect(shortenPath('/home/me/proj')).toBe('~/proj')
  })

  it('replaces the macOS home directory with ~', () => {
    expect(shortenPath('/Users/me/proj')).toBe('~/proj')
  })

  it('truncates long paths from the left, keeping the tail', () => {
    const long = 'C:\\Users\\me\\projects\\very\\deeply\\nested\\folder\\structure\\file.ts'
    const out = shortenPath(long, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('file.ts')).toBe(true)
  })

  it('leaves short paths unchanged', () => {
    expect(shortenPath('C:\\proj', 40)).toBe('C:\\proj')
  })

  it('returns an empty string for empty input', () => {
    expect(shortenPath('')).toBe('')
  })
})
