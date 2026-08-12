import { tm } from './lang'
import { execFile } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { isAbsolute, join, win32 as winPath } from 'path'
import { promisify } from 'util'
import type { GitDiff, GitStatus } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * SECURITY: never spawn git by its bare name.
 *
 * On Windows libuv resolves a bare program name against the CHILD process's cwd
 * BEFORE consulting PATH — and our cwd here is whatever folder the user merely
 * opened. A `git.exe` dropped into a repo, a zip or a shared folder would then
 * execute inside our main process the moment the git panel polls (it polls
 * automatically on cwd change and after every finished command), with no
 * approval gate and no trace in the UI. Verified empirically on Win11/Node 20:
 * a planted binary won over the real git, and NoDefaultCurrentDirectoryInExePath
 * does NOT prevent it. Same class of bug as the .git/config hardening below —
 * a malicious folder must not be able to run code just by being opened.
 *
 * So: resolve ONE absolute path from trusted locations, cache it, and if that
 * fails refuse to run git at all rather than falling back to the bare name.
 */
export function gitExeCandidates(
  platform: string,
  env: Record<string, string | undefined>
): string[] {
  if (platform === 'win32') {
    const roots = [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramW6432,
      env.LOCALAPPDATA ? winPath.join(env.LOCALAPPDATA, 'Programs') : undefined
    ]
    // win32.join, not the host's join: this function takes the platform as an
    // argument, so it must produce Windows paths even when it runs on Linux —
    // otherwise the guard's own test passes only on Windows machines.
    return roots
      .filter((r): r is string => !!r)
      .map((r) => winPath.join(r, 'Git', 'cmd', 'git.exe'))
  }
  return ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
}

/**
 * Ask the OS where git lives — running the lookup tool by absolute path AND
 * from a trusted cwd, so the lookup itself can't be hijacked the same way
 * (`where` searches the current directory before PATH).
 */
function whichGit(): Promise<string | undefined> {
  const win = process.platform === 'win32'
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const tool = win ? join(sysRoot, 'System32', 'where.exe') : '/usr/bin/which'
  const safeCwd = win ? sysRoot : '/'
  return new Promise((resolve) => {
    try {
      execFile(tool, ['git'], { cwd: safeCwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(undefined)
        const first = String(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0]
        resolve(first && isAbsolute(first) && existsSync(first) ? first : undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/** Absolute path to git, resolved once per app run. undefined → git disabled. */
let gitExePromise: Promise<string | undefined> | undefined
function gitExe(): Promise<string | undefined> {
  if (!gitExePromise) {
    gitExePromise = (async () => {
      const fixed = gitExeCandidates(process.platform, process.env).find((p) => existsSync(p))
      return fixed ?? (await whichGit())
    })()
  }
  return gitExePromise
}

/**
 * Security: these read-only status/diff commands auto-run against ANY folder the
 * user opens (terminal cwd / file tree), including untrusted ones. git honours
 * the repo-local .git/config, and several config keys make git EXECUTE a named
 * program — most notably `core.fsmonitor`, which `git status` spawns. A malicious
 * repo (shipped in a zip / shared folder) could therefore run arbitrary code in
 * our main process just by being opened. We neutralize those exec-capable keys
 * on every invocation (command-line `-c` overrides win over any config), and
 * disable prompts/optional locks. See SECURITY.md.
 */
const GIT_HARDEN = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=',
  '-c',
  'core.sshCommand=',
  '-c',
  'core.pager=cat'
]

async function git(cwd: string, args: string[]): Promise<string> {
  const exe = await gitExe()
  // No trusted git → no git features. Never fall back to the bare name: that is
  // exactly the hijackable path this resolution exists to avoid.
  if (!exe) throw new Error(tm('main.err.noGit'))
  const { stdout } = await execFileAsync(exe, [...GIT_HARDEN, ...args], {
    cwd,
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  })
  return stdout
}

export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const out = await git(cwd, ['status', '--porcelain=v2', '--branch'])
    const status: GitStatus = { root, branch: '', ahead: 0, behind: 0, dirty: 0, files: [] }
    for (const line of out.split('\n')) {
      if (!line) continue
      if (line.startsWith('# branch.head ')) {
        status.branch = line.slice('# branch.head '.length).trim()
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/)
        if (m) {
          status.ahead = parseInt(m[1], 10)
          status.behind = parseInt(m[2], 10)
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ')
        const xy = parts[1]
        const path = line.startsWith('2 ')
          ? line.split('\t')[0].split(' ').slice(9).join(' ')
          : parts.slice(8).join(' ')
        status.files.push({ path, status: xy })
      } else if (line.startsWith('? ')) {
        status.files.push({ path: line.slice(2), status: '??' })
      }
    }
    status.dirty = status.files.length
    return status
  } catch {
    return null
  }
}

/**
 * Больше этого в дифф не читаем.
 *
 * Обе стороны едут в рендерер через IPC целиком: без потолка один клик по
 * случайному дампу или видеофайлу в панели «что изменилось» затаскивает сотни
 * мегабайт в память главного процесса, сериализует их и вешает окно. Молчать об
 * обрезке нельзя — человек решит, что правка на этом и кончилась.
 */
const MAX_DIFF_BYTES = 4 * 1024 * 1024

export async function gitDiffFile(cwd: string, filePath: string): Promise<GitDiff | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const rel = filePath.replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', '')
    let original = ''
    try {
      original = await git(cwd, ['show', `HEAD:${rel}`])
    } catch {
      original = '' // new / untracked file
    }
    let modified = ''
    let tooBig = false
    try {
      const abs = join(root, rel)
      const st = await fs.stat(abs)
      if (st.size > MAX_DIFF_BYTES) {
        // Читаем начало и честно говорим, что это начало: показать пустоту или
        // подвесить окно — оба варианта хуже обрезанного, но названного куска.
        const fh = await fs.open(abs, 'r')
        try {
          const buf = Buffer.alloc(MAX_DIFF_BYTES)
          const { bytesRead } = await fh.read(buf, 0, MAX_DIFF_BYTES, 0)
          modified = buf.subarray(0, bytesRead).toString('utf8')
        } finally {
          await fh.close()
        }
        tooBig = true
      } else {
        modified = await fs.readFile(abs, 'utf8')
      }
    } catch {
      modified = '' // deleted file
    }
    if (original.length > MAX_DIFF_BYTES) {
      original = original.slice(0, MAX_DIFF_BYTES)
      tooBig = true
    }
    return { path: filePath, original, modified, ...(tooBig ? { tooBig: true } : {}) }
  } catch {
    return null
  }
}
