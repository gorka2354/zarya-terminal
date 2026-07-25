import { describe, expect, it } from 'vitest'
import { gitExeCandidates } from '../src/main/gitService'

/**
 * Regression guard for a verified RCE: git used to be spawned by bare name with
 * the opened folder as cwd, and Windows resolves a bare program name against
 * the child's cwd BEFORE PATH — so a planted git.exe ran in the main process.
 * Every candidate must be an ABSOLUTE path under a system/install location.
 */
describe('gitExeCandidates', () => {
  it('yields absolute install paths on Windows', () => {
    const c = gitExeCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
    })
    expect(c).toContain('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(c).toContain('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
    expect(c).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe')
  })

  it('never yields a bare name or a relative path (the actual vulnerability)', () => {
    const all = [
      ...gitExeCandidates('win32', {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
      }),
      ...gitExeCandidates('linux', {}),
      ...gitExeCandidates('darwin', {})
    ]
    expect(all.length).toBeGreaterThan(0)
    for (const p of all) {
      expect(p).not.toBe('git')
      expect(p).not.toBe('git.exe')
      // Absolute: either a drive letter or a leading slash.
      expect(/^([A-Za-z]:[\\/]|\/)/.test(p)).toBe(true)
    }
  })

  it('skips roots the environment does not define instead of building "undefined\\Git"', () => {
    const c = gitExeCandidates('win32', {})
    expect(c.every((p) => !/undefined/.test(p))).toBe(true)
  })

  it('uses POSIX locations off Windows', () => {
    const c = gitExeCandidates('darwin', {})
    expect(c).toContain('/usr/bin/git')
    expect(c).toContain('/opt/homebrew/bin/git')
    expect(c.every((p) => !p.endsWith('.exe'))).toBe(true)
  })
})
