import { promises as fs } from 'fs'
import { dirname } from 'path'
import { DIR_MODE, FILE_MODE, hardenFile } from './filePerms'

/** Read a JSON file, returning `fallback` when missing or corrupt. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const writeQueues = new Map<string, Promise<void>>()

/**
 * Atomic JSON write: write to a temp file, then rename over the target.
 * Writes to the same path are serialized so concurrent saves can't interleave.
 */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(dirname(file), { recursive: true, mode: DIR_MODE })
      const tmp = `${file}.${process.pid}.tmp`
      // Права ставятся на временный файл, а не после переименования: иначе между
      // созданием и chmod существует окно, в котором содержимое (в том числе
      // ключи провайдеров) читаемо всем. rename сохраняет права, так что цель
      // получает их атомарно вместе с содержимым.
      try {
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), {
          encoding: 'utf8',
          mode: FILE_MODE
        })
        await fs.rename(tmp, file)
      } catch (e) {
        /*
         * УПАЛИ — УБИРАЕМ ЗА СОБОЙ.
         *
         * Без этого каждая неудачная запись оставляла файл `<имя>.<pid>.tmp`
         * навсегда. Проверено на рабочем профиле владельца: 48 таких файлов за
         * три недели, четырнадцать из них с настройками внутри. Диск чужой, и
         * оставлять на нём мусор — ровно то, чего проект себе не позволяет.
         *
         * Ошибку пробрасываем дальше: уборка не делает неудачную запись
         * удачной, и молча проглотить её значило бы соврать вызывающему.
         */
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      // Если временный файл уже существовал, `mode` при записи не применяется —
      // подстраховываемся. Заодно это чинит файлы, созданные прошлыми версиями.
      await hardenFile(file)
    })
  writeQueues.set(file, next)
  return next
}

/**
 * Сколько временный файл должен пролежать, чтобы считаться брошенным.
 *
 * Живая запись занимает миллисекунды, так что час — предел с огромным запасом.
 * Запас нужен не нам, а второму экземпляру приложения: его запись не должна
 * попасть под нашу уборку из-за того, что он начал её мгновением раньше.
 */
const STALE_TEMP_MS = 60 * 60 * 1000

/**
 * Убрать брошенные временные файлы записи из папки.
 *
 * ПОВОД. Атомарная запись создаёт `<имя>.<pid>.tmp` и переименовывает его в
 * цель. Если процесс не дожил до переименования — файл остаётся навсегда, и
 * никто его больше не тронет: имя содержит чужой pid, а сама запись давно
 * закончилась. В рабочем профиле владельца так накопилось 48 файлов за три
 * недели, четырнадцать с настройками внутри.
 *
 * Теперь неудачная запись убирает за собой сама (см. `writeJsonAtomic`), но
 * это не чинит уже накопленное и не спасает от аварийного завершения, когда
 * выполнить `catch` некому. Поэтому уборка при старте — вторая половина.
 *
 * ЧУЖОЕ НЕ ТРОГАЕМ. Файл своего процесса пропускаем всегда, остальные — только
 * если они старше часа: два экземпляра Зари могут писать одновременно, и снести
 * чужую запись на полпути значило бы починить мусор ценой чужих данных.
 *
 * Возвращает число убранных файлов — чтобы прогон мог проверить, а не поверить.
 */
export async function sweepStaleTemps(dir: string, now = Date.now()): Promise<number> {
  let subdirs: string[]
  try {
    subdirs = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`)
  } catch {
    // Папки нет — убирать нечего. Это не ошибка: первый запуск выглядит так же.
    return 0
  }
  /*
   * ОДИН УРОВЕНЬ ВГЛУБЬ. Ревью поймало: уборка смотрела только в корень, а
   * снимки сессий пишутся в подкаталог `sessions/` — то есть туда, куда пишут
   * чаще всего и где лежит скроллбэк с перепиской. Брошенный файл там не убрал
   * бы никто и никогда.
   *
   * Глубже одного уровня не идём намеренно: своих файлов там нет, а гулять по
   * чужому дереву — не то, за чем нас звали.
   */
  let removed = await sweepOne(dir, now)
  for (const sub of subdirs) removed += await sweepOne(sub, now)
  return removed
}

/**
 * Один каталог, без спуска.
 *
 * Правило отбора живёт ЗДЕСЬ и только здесь: сперва я написал его дважды — в
 * корне и в обходе подпапок, — и это ровно тот случай, когда две копии однажды
 * разъедутся, а разойдётся в них решение об удалении чужих файлов.
 */
async function sweepOne(dir: string, now: number): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  const mine = `.${process.pid}.tmp`
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.tmp') || name.endsWith(mine)) continue
    // Только наши: `<что-то>.<цифры>.tmp`. Чужие временные файлы в этой папке
    // нам не принадлежат, и решать за них мы не вправе.
    if (!/\.\d+\.tmp$/.test(name)) continue
    const full = `${dir}/${name}`
    try {
      const st = await fs.stat(full)
      if (now - st.mtimeMs < STALE_TEMP_MS) continue
      await fs.rm(full, { force: true })
      removed++
    } catch {
      // Файл исчез сам или занят — не наша забота и не повод падать на старте.
    }
  }
  return removed
}

/** Deep merge `patch` into `base`. Arrays and non-object leaves are replaced. */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof patch !== 'object' ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: NodeJS.Timeout | undefined
  const wrapped = (...args: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  wrapped.flush = (...args: A) => {
    clearTimeout(t)
    fn(...args)
  }
  return wrapped
}
