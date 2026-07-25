import { describe, expect, it } from 'vitest'
import {
  bundledPkgName,
  claudeExeName,
  compareVersions,
  parseCliVersion,
  pickClaudeExe,
  resolveClaudeExe,
  systemClaudeCandidates
} from '../src/main/claudeExe'

describe('parseCliVersion', () => {
  it('parses the real --version banner', () => {
    expect(parseCliVersion('2.1.220 (Claude Code)')).toEqual([2, 1, 220])
  })

  it('tolerates surrounding noise and newlines', () => {
    expect(parseCliVersion('\n  2.1.217 (Claude Code)\n')).toEqual([2, 1, 217])
  })

  it('returns undefined for unparseable output', () => {
    expect(parseCliVersion('command not found')).toBeUndefined()
    expect(parseCliVersion('')).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('orders by each segment, patch included', () => {
    expect(compareVersions([2, 1, 220], [2, 1, 217])).toBe(1)
    expect(compareVersions([2, 1, 217], [2, 1, 220])).toBe(-1)
    expect(compareVersions([2, 1, 220], [2, 1, 220])).toBe(0)
  })

  it('does not compare patch numbers lexically (220 > 99)', () => {
    expect(compareVersions([2, 1, 220], [2, 1, 99])).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions([2, 1], [2, 1, 0])).toBe(0)
    expect(compareVersions([3], [2, 9, 9])).toBe(1)
  })
})

describe('bundledPkgName / claudeExeName', () => {
  it('maps each platform to its SDK binary package', () => {
    expect(bundledPkgName('win32', 'x64')).toBe('claude-agent-sdk-win32-x64')
    expect(bundledPkgName('darwin', 'arm64')).toBe('claude-agent-sdk-darwin-arm64')
    expect(bundledPkgName('linux', 'x64')).toBe('claude-agent-sdk-linux-x64')
  })

  it('only Windows gets the .exe suffix', () => {
    expect(claudeExeName('win32')).toBe('claude.exe')
    expect(claudeExeName('darwin')).toBe('claude')
    expect(claudeExeName('linux')).toBe('claude')
  })
})

describe('systemClaudeCandidates', () => {
  it('puts the npm-global install first on Windows', () => {
    const c = systemClaudeCandidates(
      'win32',
      { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      'C:\\Users\\u'
    )
    expect(c[0]).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
    )
    expect(c).toContain('C:\\Users\\u\\.local\\bin\\claude.exe')
  })

  it('survives a Windows env with no APPDATA set', () => {
    const c = systemClaudeCandidates('win32', {}, 'C:\\Users\\u')
    expect(c.length).toBeGreaterThan(0)
    expect(c.every((p) => typeof p === 'string' && p.length > 0)).toBe(true)
  })

  it('uses POSIX locations off Windows', () => {
    const c = systemClaudeCandidates('linux', {}, '/home/u')
    expect(c).toContain('/home/u/.local/bin/claude')
    expect(c).toContain('/usr/local/bin/claude')
    expect(c.every((p) => !p.endsWith('.exe'))).toBe(true)
  })
})

describe('pickClaudeExe — which binary Zarya runs', () => {
  const bundled = { path: '/app/bundled/claude', version: [2, 1, 217] }

  it('an explicit env override beats everything', () => {
    expect(
      pickClaudeExe({
        envOverride: '/custom/claude',
        bundled,
        system: { path: '/usr/bin/claude', version: [9, 9, 9] }
      })
    ).toEqual({ path: '/custom/claude', reason: 'env' })
  })

  it('ignores a blank/whitespace env override', () => {
    expect(pickClaudeExe({ envOverride: '   ', bundled }).reason).toBe('bundled')
  })

  it('prefers a strictly newer system CLI on the same major (the Opus 5 case)', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [2, 1, 220] } })
    ).toEqual({ path: '/usr/bin/claude', reason: 'system-newer' })
  })

  it('never downgrades to an older system CLI', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [2, 1, 200] } }).reason
    ).toBe('bundled')
  })

  it('does not switch on an equal version (no reason to leave the shipped binary)', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [2, 1, 217] } }).reason
    ).toBe('bundled')
  })

  it('refuses to cross a MAJOR version even when newer (protocol track guard)', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [3, 0, 0] } }).reason
    ).toBe('bundled')
  })

  it('ignores a system binary whose version could not be probed', () => {
    expect(pickClaudeExe({ bundled, system: { path: '/usr/bin/claude' } }).reason).toBe('bundled')
  })

  it('ignores a system binary when the bundled one is unprobeable', () => {
    expect(
      pickClaudeExe({
        bundled: { path: '/app/bundled/claude' },
        system: { path: '/usr/bin/claude', version: [2, 1, 220] }
      }).reason
    ).toBe('bundled')
  })

  it('falls back to the SDK default when nothing is resolvable', () => {
    expect(pickClaudeExe({})).toEqual({ reason: 'sdk-default' })
  })
})

describe('resolveClaudeExe', () => {
  it('short-circuits on ZARYA_CLAUDE_BIN without touching the disk', async () => {
    const pick = await resolveClaudeExe({
      bundledPath: '/nope/does-not-exist',
      platform: 'linux',
      env: { ZARYA_CLAUDE_BIN: '/opt/claude' },
      home: '/home/u'
    })
    expect(pick).toEqual({ path: '/opt/claude', reason: 'env' })
  })

  it('degrades to the SDK default when no binary exists anywhere', async () => {
    const pick = await resolveClaudeExe({
      bundledPath: undefined,
      platform: 'linux',
      env: {},
      home: '/nonexistent-home-for-test'
    })
    expect(pick.reason).toBe('sdk-default')
    expect(pick.path).toBeUndefined()
  })
})
