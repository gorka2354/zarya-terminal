import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as pty from '@lydell/node-pty'
import { CH } from '@shared/ipc'
import type { PtySpawnRequest, PtySpawnResult, ShellProfile } from '@shared/types'
import { builtinResourcesDir } from './workflowStore'

function integrationDir(): string {
  return join(builtinResourcesDir(), 'shell-integration')
}

/** git-bash understands C:/foo/bar style paths. */
function toBashPath(p: string): string {
  return p.replace(/\\/g, '/')
}

export class PtyManager {
  private ptys = new Map<string, pty.IPty>()
  private getWindow: () => BrowserWindow | null

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow
  }

  async spawn(req: PtySpawnRequest, profile: ShellProfile): Promise<PtySpawnResult> {
    if (this.ptys.has(req.sessionId)) {
      return { ok: false, error: 'session already has a pty' }
    }

    let cwd = req.cwd && existsSync(req.cwd) ? req.cwd : homedir()
    const nonce = randomBytes(16).toString('hex')

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...profile.env,
      ZARYA: '1',
      ZARYA_VERSION: app.getVersion(),
      ZARYA_NONCE: nonce,
      TERM_PROGRAM: 'Zarya',
      TERM_PROGRAM_VERSION: app.getVersion(),
      COLORTERM: 'truecolor'
    }
    delete env.ELECTRON_RUN_AS_NODE

    const args = [...profile.args]
    const siDir = integrationDir()
    try {
      if (profile.integration === 'powershell') {
        const script = join(siDir, 'integration.ps1')
        if (existsSync(script)) {
          const quoted = script.replace(/'/g, "''")
          args.push('-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${quoted}'`)
        }
      } else if (profile.integration === 'bash') {
        const script = join(siDir, 'integration.bash')
        if (existsSync(script)) {
          args.push('--rcfile', toBashPath(script), '-i')
        } else {
          args.push('-i')
        }
      } else if (profile.integration === 'zsh') {
        const script = join(siDir, 'integration.zsh')
        if (existsSync(script)) {
          // ZDOTDIR trick: a generated .zshrc sources the user rc, then ours.
          const zdot = join(app.getPath('userData'), 'zdot')
          await fs.mkdir(zdot, { recursive: true })
          await fs.writeFile(
            join(zdot, '.zshrc'),
            `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\nsource "${script}"\n`,
            'utf8'
          )
          env.ZDOTDIR = zdot
        }
      }
    } catch {
      // Shell integration is best-effort; the terminal still works without it.
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(profile.path, args, {
        name: 'xterm-256color',
        cols: req.cols || 80,
        rows: req.rows || 24,
        cwd,
        env,
        useConpty: true
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    this.ptys.set(req.sessionId, proc)

    proc.onData((data) => {
      this.getWindow()?.webContents.send(CH.ptyData, req.sessionId, data)
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(req.sessionId)
      this.getWindow()?.webContents.send(CH.ptyExit, req.sessionId, exitCode)
    })

    return { ok: true, pid: proc.pid, cwd, profile, nonce }
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1 || cols > 1000 || rows > 500) return
    try {
      this.ptys.get(sessionId)?.resize(cols, rows)
    } catch {
      // pty may have just exited
    }
  }

  kill(sessionId: string): void {
    const p = this.ptys.get(sessionId)
    if (!p) return
    this.ptys.delete(sessionId)
    try {
      p.kill()
    } catch {
      // already dead
    }
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
