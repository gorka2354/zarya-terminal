import { tm } from './lang'
import { isAbsolute } from 'path'
import type { ShellIntegrationKind, ShellProfile } from '@shared/types'

/**
 * SECURITY: `terminal.customProfiles` is a list of programs the app will spawn,
 * and `settings:set` is reachable from the renderer. A compromised renderer
 * could therefore write a profile pointing at any binary (with any argv and any
 * environment) and have it launched on every later start — turning a one-shot
 * compromise into PERSISTENCE, which survives reload and restart. The renderer
 * already has `pty.write`, so this is not an escalation of what it can do *now*;
 * it is an escalation of how long it lasts.
 *
 * Two things guard it, because neither is sufficient alone:
 *
 *  1. This module — structural validation. It rejects malformed entries and
 *     strips environment variables that turn a benign shell into an execution
 *     primitive (LD_PRELOAD and friends). It cannot, however, tell
 *     `powershell.exe -c <evil>` from a legitimate profile: both are "an
 *     existing binary with arguments".
 *  2. An explicit confirmation dialog in the main process (see ipc.ts), shown
 *     whenever the set of profiles actually changes. That covers case 1's blind
 *     spot — the user sees the path and argv before anything is stored.
 *
 * There is no UI that writes custom profiles today, so in practice every write
 * arriving over IPC is either a future feature or an attack. Fail closed.
 */

/** Longest accepted string field — a label, not an essay. */
const MAX_STR = 512
/** Longest accepted single argument, and how many of them. */
const MAX_ARG = 2048
const MAX_ARGS = 64
const MAX_ENV_KEYS = 64
const MAX_PROFILES = 32

const INTEGRATIONS: ShellIntegrationKind[] = ['powershell', 'bash', 'zsh', 'none']

/**
 * Environment a profile may carry — an ALLOW list, deliberately.
 *
 * A deny list cannot be finished here. Every shell this app launches has its own
 * way to turn a variable into code: `PROMPT_COMMAND`, `PS0`/`PS1` (command
 * substitution in the prompt), `BASH_FUNC_x%%` (exported function overriding
 * `ls`), `PSModulePath`, `GIT_SSH_COMMAND`, `PYTHONPATH`, `BASH_ENV` … and
 * `HOME`, because the shell-integration scripts we install source
 * `$HOME/.bashrc` / `$HOME/.zshrc` themselves. Enumerating that is a losing
 * game: one forgotten name is code execution.
 *
 * So a profile gets locale, timezone and proxy — everything else is dropped. If
 * a future profile legitimately needs another variable, add it here explicitly.
 */
const ENV_ALLOW = [
  /^LANG$/i,
  /^LANGUAGE$/i,
  /^LC_[A-Z_]+$/i,
  /^TZ$/i,
  /^TERM$/i,
  /^COLORTERM$/i,
  /^(HTTP|HTTPS|ALL|NO)_PROXY$/i
]

/** Control characters, NUL and newlines have no place in any of these fields. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

function cleanStr(v: unknown, max = MAX_STR): string | null {
  if (typeof v !== 'string') return null
  if (v.length === 0 || v.length > max) return null
  if (CONTROL_RE.test(v)) return null
  return v
}

/**
 * Validates one profile. Returns null when it must not be stored — callers treat
 * that as "drop this entry", never as "store it unchanged".
 *
 * `exists` is injected so the check is testable without touching the disk; the
 * caller passes a real fs probe. The existence check is advisory: a file can
 * appear or be swapped afterwards (TOCTOU), which is precisely why the
 * confirmation dialog — not this function — is the real gate.
 */
export function sanitizeProfile(
  raw: unknown,
  exists: (p: string) => boolean = () => true
): ShellProfile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  const id = cleanStr(r.id, 128)
  const name = cleanStr(r.name)
  const path = cleanStr(r.path, MAX_ARG)
  if (!id || !name || !path) return null

  // Absolute only: a bare name would be resolved against PATH (or, on Windows,
  // against the child's cwd first) — the very lookup-order trap already fixed
  // for git. An absolute path is unambiguous.
  if (!isAbsolute(path)) return null
  if (!exists(path)) return null

  if (r.args !== undefined && !Array.isArray(r.args)) return null
  const rawArgs = Array.isArray(r.args) ? r.args : []
  if (rawArgs.length > MAX_ARGS) return null
  const args: string[] = []
  for (const a of rawArgs) {
    const s = cleanStr(a, MAX_ARG)
    if (s === null) return null
    args.push(s)
  }

  const integration = INTEGRATIONS.includes(r.integration as ShellIntegrationKind)
    ? (r.integration as ShellIntegrationKind)
    : 'none'

  let env: Record<string, string> | undefined
  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env)) return null
    const entries = Object.entries(r.env as Record<string, unknown>)
    if (entries.length > MAX_ENV_KEYS) return null
    const out: Record<string, string> = {}
    for (const [k, v] of entries) {
      const key = cleanStr(k, 128)
      const val = typeof v === 'string' && !CONTROL_RE.test(v) && v.length <= MAX_ARG ? v : null
      if (!key || val === null) return null
      if (!ENV_ALLOW.some((re) => re.test(key))) continue // drop, don't reject
      out[key] = val
    }
    if (Object.keys(out).length > 0) env = out
  }

  return {
    id,
    name,
    path,
    args,
    ...(env ? { env } : {}),
    integration,
    icon: cleanStr(r.icon, 16) ?? '›',
    // `detected: true` marks a profile the app found itself. A stored profile is
    // by definition user-supplied, so it must never be able to claim otherwise.
    detected: false
  }
}

/** Validates a whole list, dropping entries that fail. */
export function sanitizeProfiles(
  raw: unknown,
  exists: (p: string) => boolean = () => true
): ShellProfile[] {
  if (!Array.isArray(raw)) return []
  const out: ShellProfile[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_PROFILES)) {
    const p = sanitizeProfile(item, exists)
    if (!p || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/** Identity of a profile for change detection — everything that affects execution. */
function execIdentity(p: ShellProfile): string {
  return JSON.stringify([p.id, p.path, p.args, p.env ?? {}, p.integration])
}

/**
 * Profiles in `next` that would newly execute something: added, or changed in a
 * way that alters what runs. Renaming or re-icon-ing an existing profile is not
 * a new execution and must not nag the user.
 */
export function newlyExecutable(prev: ShellProfile[], next: ShellProfile[]): ShellProfile[] {
  const before = new Set(prev.map(execIdentity))
  return next.filter((p) => !before.has(execIdentity(p)))
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * Human summary for the confirmation dialog.
 *
 * Two rules learned the hard way. Everything is CLIPPED, because a native dialog
 * does not scroll: 64 arguments of 2 KB each would push the interesting
 * `-c <payload>` hundreds of wrapped lines below the screen edge while the first
 * line still reads like an ordinary «Git Bash» profile. And environment VALUES
 * are shown, not just names — `окружение: PROMPT_COMMAND` looks innocuous, while
 * the value is the payload. The path is never clipped: it is the one thing the
 * decision must rest on.
 */
export function describeProfile(p: ShellProfile): string {
  const argv = p.args.length ? clip(` ${p.args.join(' ')}`, 200) : ''
  const env =
    p.env && Object.keys(p.env).length
      ? `\n${tm('main.dlg.env')}\n` +
        Object.entries(p.env)
          .map(([k, v]) => `  ${clip(k, 64)}=${clip(v, 120)}`)
          .join('\n')
      : ''
  return `«${clip(p.name, 80)}»\n${p.path}${argv}${env}`
}
