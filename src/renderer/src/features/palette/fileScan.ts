/**
 * Обход файлов рабочей папки — общий для Ctrl+P и упоминаний «@».
 *
 * Жил внутри QuickOpen и был ему личным. Упоминанию нужен ровно тот же список
 * (те же пропуски, та же глубина, тот же потолок), и второй такой обход рядом
 * разошёлся бы с первым на первой же правке: человек видел бы в двух местах
 * разные файлы одного проекта.
 */
import type { DirEntry } from '@shared/types'

/** Папки, в которые не ходим: их содержимое человек в проекте не ищет. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release'])
const MAX_DEPTH = 4
const MAX_FILES = 3000

export interface ScannedFile {
  /** Абсолютный путь. */
  path: string
  /** Относительный к корню обхода, через прямые слэши. */
  rel: string
  name: string
}

export function toRel(root: string, full: string): string {
  let rel = full.startsWith(root) ? full.slice(root.length) : full
  rel = rel.replace(/^[\\/]+/, '')
  return rel.replace(/\\/g, '/')
}

/**
 * Обойти папку вширь с ограничением по глубине и числу файлов.
 *
 * Границы намеренные: без них открытая в корне диска панель уводила бы обход в
 * десятки тысяч файлов, а список всё равно показывает первые строки.
 */
export async function scanFiles(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = []
  let level: string[] = [root]
  let depth = 0
  while (level.length && depth < MAX_DEPTH && files.length < MAX_FILES) {
    const nextLevel: string[] = []
    const results = await Promise.all(
      level.map((dir) => window.zarya.fs.readDir(dir).catch(() => [] as DirEntry[]))
    )
    for (const entries of results) {
      for (const entry of entries) {
        if (files.length >= MAX_FILES) break
        if (entry.isDir) {
          if (SKIP_DIRS.has(entry.name)) continue
          nextLevel.push(entry.path)
        } else {
          files.push({ path: entry.path, rel: toRel(root, entry.path), name: entry.name })
        }
      }
    }
    level = nextLevel
    depth++
  }
  return files
}
