import { lstatSync, promises as fs } from 'fs'
import { createHash } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'

/**
 * Что лежит на диске по путям, которых коснётся откат, — и что там осталось
 * после него.
 *
 * Две проверки, обе оплачены находками ревью:
 *
 * ДО отката. Движок пропускает симлинки и хардлинки, но узнаём мы об этом
 * ПОСЛЕ — числом `skippedLinks` в ответе, когда файлы уже тронуты. На Windows
 * junction ставится без прав администратора, то есть это не экзотика. Сказать
 * заранее «этот путь откат пропустит» можно только своим `lstat`.
 *
 * ПОСЛЕ отката. Числам движка нельзя верить как отчёту: часть его собственных
 * промахов не попадает никуда (пропала резервная копия — `skippedLinks` не
 * выставлен, исключения нет, `canRewind:true`). Рапорт «откатили 5 файлов»
 * после того, как один остался в прежнем виде, — это враньё уже после
 * необратимого действия. Поэтому считаем сами.
 */

export interface DiskFacts {
  path: string
  /** Файл существует прямо сейчас. */
  existsNow: boolean
  /** Не обычный файл: симлинк, junction, устройство — движок такой путь пропустит. */
  linkSkipped?: boolean
  /** Путь вне рабочей папки агента. */
  outsideCwd?: boolean
  /** Размер и отпечаток содержимого — для пост-сверки. */
  size?: number
  hash?: string
}

/** Больше этого не хешируем целиком: карточка не должна ждать диск. */
const FULL_HASH_LIMIT = 2 * 1024 * 1024

/**
 * Отпечаток содержимого.
 *
 * Для больших файлов — размер плюс края: полный хеш гигабайтного файла человек
 * ждал бы секундами, а нам нужен ответ на вопрос «это всё ещё то же самое»,
 * а не криптографическая стойкость.
 */
export async function fileHash(path: string): Promise<string | undefined> {
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return undefined
    if (st.size <= FULL_HASH_LIMIT) {
      const buf = await fs.readFile(path)
      return createHash('sha1').update(buf).digest('hex')
    }
    const fh = await fs.open(path, 'r')
    try {
      const head = Buffer.alloc(64 * 1024)
      const tail = Buffer.alloc(64 * 1024)
      await fh.read(head, 0, head.length, 0)
      await fh.read(tail, 0, tail.length, Math.max(0, st.size - tail.length))
      return createHash('sha1')
        .update(String(st.size))
        .update(head)
        .update(tail)
        .digest('hex')
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}

/** Лежит ли путь внутри папки агента. Пустой `cwd` — сравнивать не с чем. */
export function outsideCwd(path: string, cwd: string): boolean {
  if (!cwd || !isAbsolute(path)) return false
  const rel = relative(resolve(cwd), resolve(path))
  return rel === '' ? false : rel.startsWith('..') || isAbsolute(rel)
}

/** Состояние путей ДО отката — из него строится карточка. */
export async function diskFacts(paths: string[], cwd: string): Promise<DiskFacts[]> {
  return Promise.all(
    paths.map(async (path) => {
      const out: DiskFacts = { path, existsNow: false }
      try {
        // Именно lstat, а не stat: stat идёт ПО ссылке и сказал бы про цель,
        // а вопрос у нас про сам путь — его движок и пропустит.
        const st = lstatSync(path)
        out.existsNow = true
        if (!st.isFile()) out.linkSkipped = true
        else out.size = st.size
      } catch {
        out.existsNow = false
      }
      if (outsideCwd(path, cwd)) out.outsideCwd = true
      if (out.existsNow && !out.linkSkipped) out.hash = await fileHash(path)
      return out
    })
  )
}

export interface RewindVerdict {
  /** Файл и правда изменился или исчез — откат до него дошёл. */
  restored: number
  /** Движок путь не тронул: как было до отката, так и осталось. */
  untouched: number
  /** Файл был и остался, но мы не смогли его прочитать ни до, ни после. */
  unknown: number
  /** Пути, которые остались прежними, — чтобы назвать их человеку. */
  untouchedPaths: string[]
}

/**
 * Что произошло на самом деле.
 *
 * Сравниваем состояние до и после по каждому пути. «Ничего не изменилось» —
 * это НЕ успех: значит откат до этого файла не дошёл, и человек обязан узнать
 * об этом числом, а не думать, что вернулось всё.
 */
export async function verifyRewind(before: DiskFacts[], cwd: string): Promise<RewindVerdict> {
  const after = await diskFacts(
    before.map((b) => b.path),
    cwd
  )
  const out: RewindVerdict = { restored: 0, untouched: 0, unknown: 0, untouchedPaths: [] }
  for (let i = 0; i < before.length; i++) {
    const b = before[i]
    const a = after[i]
    if (b.existsNow !== a.existsNow) {
      out.restored++
      continue
    }
    if (!b.existsNow && !a.existsNow) {
      // Не было и нет: откат должен был его создать, но не создал.
      out.untouched++
      out.untouchedPaths.push(b.path)
      continue
    }
    if (b.hash && a.hash) {
      if (b.hash !== a.hash) out.restored++
      else {
        out.untouched++
        out.untouchedPaths.push(b.path)
      }
      continue
    }
    // Не смогли прочитать (ссылка, права, файл занят) — молчать нельзя, но и
    // объявлять успехом тоже: это отдельное число.
    out.unknown++
  }
  return out
}
