import { shell } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import type { DirEntry, FileContent } from '@shared/types'

const MAX_FILE_SIZE = 1.5 * 1024 * 1024

export async function readDir(path: string): Promise<DirEntry[]> {
  const items = await fs.readdir(path, { withFileTypes: true })
  const out: DirEntry[] = []
  for (const it of items) {
    const full = join(path, it.name)
    let size = 0
    let mtime = 0
    try {
      const st = await fs.stat(full)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      // broken symlink / access denied — still list it
    }
    out.push({ name: it.name, path: full, isDir: it.isDirectory(), size, mtime })
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return out
}

export async function readFile(path: string): Promise<FileContent> {
  const st = await fs.stat(path)
  const size = st.size
  const truncated = size > MAX_FILE_SIZE
  const fh = await fs.open(path, 'r')
  const len = Math.min(size, MAX_FILE_SIZE)
  const buf = Buffer.alloc(len)
  await fh.read(buf, 0, len, 0)
  await fh.close()
  const head = buf.subarray(0, Math.min(8192, buf.length))
  const binary = head.includes(0)
  return {
    path,
    content: binary ? '' : buf.toString('utf8'),
    truncated,
    binary,
    size
  }
}

export async function writeFile(path: string, content: string): Promise<void> {
  await fs.writeFile(path, content, 'utf8')
}

export async function statPath(
  path: string
): Promise<{ exists: boolean; isDir: boolean; size: number } | null> {
  try {
    const st = await fs.stat(path)
    return { exists: true, isDir: st.isDirectory(), size: st.size }
  } catch {
    return { exists: false, isDir: false, size: 0 }
  }
}

export async function createEntry(path: string, isDir: boolean): Promise<void> {
  if (isDir) {
    await fs.mkdir(path, { recursive: true })
  } else {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, '', { flag: 'wx' })
  }
}

export async function renameEntry(from: string, to: string): Promise<void> {
  await fs.rename(from, to)
}

/** Delete moves to the OS trash — reversible by design. */
export async function deleteEntry(path: string): Promise<void> {
  await shell.trashItem(path)
}
