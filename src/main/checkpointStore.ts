import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Сколько места занимают копии файлов, которые движок снимает перед правками.
 *
 * Зачем считать, а не написать «около 3-10 МБ на сессию»: это ЧУЖАЯ папка,
 * растущая от нашей настройки. Константа в интерфейсе — это обещание, которое
 * мы не контролируем: на машине владельца там уже 136 МБ от одного лишь
 * консольного Claude Code, и человек вправе видеть настоящее число, а не наше
 * представление о нём.
 *
 * Папку определяет движок от домашней папки — `CLAUDE_CONFIG_DIR` её
 * переопределяет, и мы обязаны смотреть туда же, иначе покажем ноль там, где на
 * диске гигабайты (или наоборот, чужие данные вместо своих).
 */
export function fileHistoryDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  return join(base, 'file-history')
}

export interface CheckpointUsage {
  /** Суммарный размер в байтах. */
  bytes: number
  /** Сколько сессий (подпапок) там лежит. */
  sessions: number
  /** Папки нет вовсе — движок ещё ничего не копировал. */
  missing?: boolean
  /**
   * Обход остановлен на пределе: показанное число — НИЖНЯЯ граница.
   *
   * Считать честно, но не любой ценой: на большой папке полный обход занял бы
   * секунды и подвесил бы экран настроек. Соврать в меньшую сторону молча
   * нельзя — поэтому признак едет в интерфейс и превращается в «не меньше чем».
   */
  partial?: boolean
}

/** Больше этого не обходим: экран настроек не должен ждать файловую систему. */
const MAX_ENTRIES = 20_000

export async function checkpointUsage(dir = fileHistoryDir()): Promise<CheckpointUsage> {
  let bytes = 0
  let sessions = 0
  let seen = 0
  let partial = false

  let top: string[]
  try {
    top = await fs.readdir(dir)
  } catch {
    return { bytes: 0, sessions: 0, missing: true }
  }

  for (const name of top) {
    if (seen >= MAX_ENTRIES) {
      partial = true
      break
    }
    const sub = join(dir, name)
    let entries: string[]
    try {
      entries = await fs.readdir(sub)
    } catch {
      // Не каталог (или недоступен) — считаем как одиночный файл.
      try {
        const st = await fs.stat(sub)
        bytes += st.size
        seen++
      } catch {
        /* пропал между чтением списка и stat — не наша забота */
      }
      continue
    }
    sessions++
    for (const f of entries) {
      if (seen >= MAX_ENTRIES) {
        partial = true
        break
      }
      try {
        const st = await fs.stat(join(sub, f))
        bytes += st.size
        seen++
      } catch {
        /* исчез по дороге */
      }
    }
  }

  return { bytes, sessions, ...(partial ? { partial: true } : {}) }
}
