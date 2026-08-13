import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { ShellProfile } from '@shared/types'

const execFileAsync = promisify(execFile)

let cache: ShellProfile[] | null = null

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [
      cmd
    ])
    const first = stdout.split(/\r?\n/).find((l) => l.trim())
    return first?.trim() ?? null
  } catch {
    return null
  }
}

async function detectWindows(): Promise<ShellProfile[]> {
  const profiles: ShellProfile[] = []
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'

  const pwsh = await which('pwsh')
  if (pwsh) {
    profiles.push({
      id: 'pwsh',
      name: 'PowerShell',
      path: pwsh,
      args: [],
      integration: 'powershell',
      icon: 'PS',
      detected: true
    })
  }

  const winPs = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(winPs)) {
    profiles.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      path: winPs,
      args: [],
      integration: 'powershell',
      icon: 'PS',
      detected: true
    })
  }

  const comspec = process.env.ComSpec ?? join(sysRoot, 'System32', 'cmd.exe')
  if (existsSync(comspec)) {
    profiles.push({
      id: 'cmd',
      name: 'Command Prompt',
      path: comspec,
      args: [],
      integration: 'none',
      icon: 'CMD',
      detected: true
    })
  }

  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ]
  const gitExe = await which('git')
  if (gitExe) {
    // e.g. C:\Program Files\Git\cmd\git.exe -> C:\Program Files\Git\bin\bash.exe
    gitBashCandidates.unshift(join(gitExe, '..', '..', 'bin', 'bash.exe'))
  }
  const gitBash = gitBashCandidates.find((p) => existsSync(p))
  if (gitBash) {
    profiles.push({
      id: 'git-bash',
      name: 'Git Bash',
      path: gitBash,
      args: [],
      integration: 'bash',
      icon: 'SH',
      detected: true
    })
  }

  // WSL distros: `wsl.exe -l -q` prints UTF-16LE
  // Resolved to an ABSOLUTE path like every other profile here: a bare
  // 'wsl.exe' is resolved by the loader against PATH — and on Windows against
  // the child cwd FIRST — the same lookup-order trap already closed for git.
  // Absolute is also what lets it survive the spawn-time profile check.
  const wslExe = (await which('wsl')) ?? join(sysRoot, 'System32', 'wsl.exe')
  try {
    const { stdout } = await execFileAsync(wslExe, ['-l', '-q'], {
      encoding: 'buffer' as never
    })
    const text = Buffer.from(stdout as unknown as Buffer).toString('utf16le')
    for (const line of text.split(/\r?\n/)) {
      const name = line.replace(/\u0000/g, '').trim()
      if (!name) continue
      profiles.push({
        id: `wsl-${name.toLowerCase()}`,
        name: `WSL · ${name}`,
        path: wslExe,
        args: ['-d', name],
        integration: 'none',
        icon: 'WSL',
        detected: true
      })
    }
  } catch {
    // WSL not installed
  }

  return profiles
}

async function detectUnix(): Promise<ShellProfile[]> {
  const profiles: ShellProfile[] = []
  const userShell = process.env.SHELL
  const candidates: Array<[string, string, ShellProfile['integration'], string]> = [
    ['zsh', '/bin/zsh', 'zsh', 'ZSH'],
    ['bash', '/bin/bash', 'bash', 'SH'],
    ['fish', '/usr/bin/fish', 'none', 'FSH']
  ]
  for (const [id, path, integration, icon] of candidates) {
    const found = existsSync(path) ? path : await which(id)
    if (found) {
      profiles.push({
        id,
        name: id,
        path: found,
        args: [],
        integration,
        icon,
        detected: true
      })
    }
  }
  if (userShell && !profiles.some((p) => p.path === userShell)) {
    profiles.unshift({
      id: 'default',
      name: userShell.split('/').pop() ?? 'shell',
      path: userShell,
      args: [],
      integration: 'none',
      icon: '>_',
      detected: true
    })
  }
  return profiles
}

/**
 * Где системный `ssh`.
 *
 * Профилю нужен АБСОЛЮТНЫЙ путь: страж профилей коротких имён не принимает, и
 * правильно делает — «ssh» из PATH зависит от того, что в PATH лежит сейчас.
 *
 * Ищем только `ssh` и ничего больше: канал открыт окну, и «найди мне любой
 * исполняемый файл» превратило бы его в разведку по чужой файловой системе.
 */
export async function locateSsh(): Promise<string | null> {
  return which('ssh')
}

export async function detectShells(): Promise<ShellProfile[]> {
  if (cache) return cache
  cache = process.platform === 'win32' ? await detectWindows() : await detectUnix()
  return cache
}

/** Resolve a profile id (or 'auto') against detected + custom profiles. */
export async function resolveProfile(
  profileId: string,
  customProfiles: ShellProfile[]
): Promise<ShellProfile | null> {
  // Detected profiles FIRST: a custom profile is renderer-writable, so if one
  // claims a well-known id ('pwsh', 'cmd', …) it must not shadow the real shell
  // that the auto profile resolves to — that would silently redirect every new terminal.
  const all = [...(await detectShells()), ...customProfiles]
  if (profileId !== 'auto') {
    return all.find((p) => p.id === profileId) ?? all[0] ?? null
  }
  const order = ['pwsh', 'powershell', 'zsh', 'bash', 'cmd']
  for (const id of order) {
    const p = all.find((x) => x.id === id)
    if (p) return p
  }
  return all[0] ?? null
}
