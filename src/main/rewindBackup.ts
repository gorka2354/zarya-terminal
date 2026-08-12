import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * Копия того, что человек потеряет, — снятая ДО отката.
 *
 * У движка есть «до агента», но нет «до отката»: нажал — и ручная правка
 * исчезла без следа. Ни корзины, ни reflog, если файл не в git. Поэтому перед
 * необратимым действием мы копируем то, что рискует пропасть.
 *
 * СТРАХУЕМ НЕ ВСЁ, А СПОРНОЕ. Копировать каждый файл из списка значит платить
 * диском за случаи, где терять нечего: файл в том виде, в каком его оставил
 * агент, движок вернёт к прежнему состоянию — это ровно то, что человек и
 * просил. Спорных обычно ноль-три: те, где содержимое разошлось с записанным
 * агентом, и те, про которые мы ничего не знаем.
 *
 * И ЭТО НЕ МУСОР. У копий есть потолок, срок и уборка: не больше одного отката
 * на беседу, не больше MAX_TOTAL байт за раз, старше MAX_AGE_MS удаляется при
 * следующем откате. Не влезло — говорим об этом в ответе, а не молчим: «мы
 * сохранили» там, где не сохранили, хуже, чем «не сохранили».
 */

/** Больше этого за один откат не копируем. */
const MAX_TOTAL = 32 * 1024 * 1024
/** Копии старше этого удаляются при следующем откате. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface BackupResult {
  /** Куда сложены копии (пусто — копировать было нечего). */
  dir?: string
  /** Сколько файлов сохранено. */
  saved: number
  /** Файлы, которые не поместились в лимит и НЕ сохранены. */
  skipped: string[]
}

function root(): string {
  return join(app.getPath('userData'), 'rewind-backup')
}

/** Имя файла-копии: плоское и однозначное, без воссоздания дерева папок. */
function flatName(path: string): string {
  const base = path.split(/[\\/]/).pop() || 'file'
  const tag = createHash('sha1').update(path).digest('hex').slice(0, 8)
  return `${tag}-${base}`
}

/**
 * Сохранить спорные файлы перед откатом.
 *
 * `convId` в имени папки, чтобы человек мог понять, к какой беседе относится
 * копия, а мы — снять её вместе с беседой.
 */
export async function backupBeforeRewind(
  convId: string,
  paths: string[],
  now = Date.now()
): Promise<BackupResult> {
  if (!paths.length) return { saved: 0, skipped: [] }
  await cleanupOld(now)
  const dir = join(root(), `${convId}-${now}`)
  await fs.mkdir(dir, { recursive: true })

  let total = 0
  let saved = 0
  const skipped: string[] = []
  for (const p of paths) {
    try {
      const st = await fs.stat(p)
      if (total + st.size > MAX_TOTAL) {
        // Молча пропустить нельзя: человек решает, жать ли «Откатить», глядя
        // в том числе на то, что мы обещали сохранить.
        skipped.push(p)
        continue
      }
      await fs.copyFile(p, join(dir, flatName(p)))
      total += st.size
      saved++
    } catch {
      skipped.push(p)
    }
  }
  if (!saved) {
    // Пустая папка — тот самый мусор, которого мы обещали не оставлять.
    try {
      await fs.rmdir(dir)
    } catch {
      /* не пусто или уже нет */
    }
    return { saved: 0, skipped }
  }
  return { dir, saved, skipped }
}

/** Уборка: копии старше срока и копии закрытых бесед. */
export async function cleanupOld(now = Date.now()): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(root())
  } catch {
    return
  }
  for (const name of entries) {
    const at = Number(name.slice(name.lastIndexOf('-') + 1))
    if (!Number.isFinite(at) || now - at < MAX_AGE_MS) continue
    try {
      await fs.rm(join(root(), name), { recursive: true, force: true })
    } catch {
      /* занято — уберём в следующий раз */
    }
  }
}

/**
 * Сколько занимают НАШИ страховочные копии — и сколько их.
 *
 * Показываем отдельно от папки движка: там его копии и его же срок, а здесь
 * наши, и убирать их человек вправе в один клик. Смешать их в одну цифру
 * значило бы предложить удалить чужое.
 */
export async function backupUsage(): Promise<{ dir: string; bytes: number; runs: number }> {
  const dir = root()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return { dir, bytes: 0, runs: 0 }
  }
  let bytes = 0
  for (const name of entries) {
    try {
      for (const f of await fs.readdir(join(dir, name))) {
        bytes += (await fs.stat(join(dir, name, f))).size
      }
    } catch {
      /* исчезло по дороге */
    }
  }
  return { dir, bytes, runs: entries.length }
}

/** Убрать ВСЕ наши страховочные копии по просьбе человека. */
export async function clearBackups(): Promise<void> {
  try {
    await fs.rm(root(), { recursive: true, force: true })
  } catch {
    /* нечего убирать */
  }
}

/** Снять копии этой беседы (беседу закрыли или удалили). */
export async function forgetBackups(convId: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(root())
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((n) => n.startsWith(`${convId}-`))
      .map((n) => fs.rm(join(root(), n), { recursive: true, force: true }).catch(() => undefined))
  )
}
