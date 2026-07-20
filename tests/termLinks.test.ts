import { describe, expect, it } from 'vitest'
import { findPathsInLine, resolveAgainstCwd } from '@/terminal/termLinks'

describe('findPathsInLine', () => {
  it('finds an absolute windows path', () => {
    const result = findPathsInLine('Failed to open C:\\x\\y.ts')
    expect(result).toEqual([{ start: 16, end: 24, path: 'C:\\x\\y.ts', line: undefined }])
  })

  it('finds an absolute unix path', () => {
    const result = findPathsInLine('see file at /usr/bin/node')
    expect(result).toEqual([{ start: 13, end: 25, path: '/usr/bin/node', line: undefined }])
  })

  it('finds a relative path (./)', () => {
    const result = findPathsInLine('edit ./src/a.ts')
    expect(result).toEqual([{ start: 6, end: 15, path: './src/a.ts', line: undefined }])
  })

  it('parses a :line suffix', () => {
    const result = findPathsInLine('error at ./src/a.ts:42 now')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('./src/a.ts')
    expect(result[0].line).toBe(42)
  })

  it('parses a :line:col suffix, keeping only line', () => {
    const result = findPathsInLine('error at ./src/a.ts:42:7 now')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('./src/a.ts')
    expect(result[0].line).toBe(42)
  })

  it('parses a windows path with :line:col suffix', () => {
    const result = findPathsInLine('error at C:\\x\\y.ts:42:7 now')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('C:\\x\\y.ts')
    expect(result[0].line).toBe(42)
  })

  it('strips a trailing sentence-ending period', () => {
    const result = findPathsInLine('Please check the file at ./src/a.ts.')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('./src/a.ts')
    expect(result[0].path.endsWith('.')).toBe(false)
  })

  it('returns an empty array when the line has no paths', () => {
    expect(findPathsInLine('no paths in this plain sentence at all')).toEqual([])
  })
})

describe('resolveAgainstCwd', () => {
  it('resolves a relative windows path against cwd', () => {
    expect(resolveAgainstCwd('.\\src\\a.ts', 'C:\\proj')).toBe('C:\\proj\\src\\a.ts')
  })

  it('handles .. navigation', () => {
    expect(resolveAgainstCwd('..\\lib\\b.ts', 'C:\\proj\\src')).toBe('C:\\proj\\lib\\b.ts')
  })

  it('leaves an absolute windows path unchanged', () => {
    expect(resolveAgainstCwd('C:\\abs\\c.ts', 'C:\\proj')).toBe('C:\\abs\\c.ts')
  })

  it('resolves a relative unix path against cwd', () => {
    expect(resolveAgainstCwd('./src/a.ts', '/home/me/proj')).toBe('/home/me/proj/src/a.ts')
  })

  it('leaves an absolute unix path unchanged', () => {
    expect(resolveAgainstCwd('/abs/c.ts', '/home/me/proj')).toBe('/abs/c.ts')
  })
})
