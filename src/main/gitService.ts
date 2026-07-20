import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { GitDiff, GitStatus } from '@shared/types'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
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

export async function gitDiffFile(cwd: string, filePath: string): Promise<GitDiff | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const rel = filePath
      .replace(/\\/g, '/')
      .replace(root.replace(/\\/g, '/') + '/', '')
    let original = ''
    try {
      original = await git(cwd, ['show', `HEAD:${rel}`])
    } catch {
      original = '' // new / untracked file
    }
    let modified = ''
    try {
      modified = await fs.readFile(join(root, rel), 'utf8')
    } catch {
      modified = '' // deleted file
    }
    return { path: filePath, original, modified }
  } catch {
    return null
  }
}
