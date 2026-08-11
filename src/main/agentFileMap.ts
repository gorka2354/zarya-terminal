import { fileHash } from './rewindFacts'

/**
 * Что агент записал в файл — и трогал ли его кто-то ещё после этого.
 *
 * Родной откат движка молча затирает ручные правки: он возвращает файл к
 * состоянию «до агента», не спрашивая, что появилось в нём потом. Сухой прогон
 * об этом не предупреждает — проверено живым прогоном, где строка `HUMAN EDIT`
 * исчезла без единого слова. Единственный способ предупредить заранее —
 * помнить, что записал агент, и сравнивать с тем, что лежит на диске сейчас.
 *
 * ПОЧЕМУ СОДЕРЖИМОЕ, А НЕ ВРЕМЯ ПРАВКИ. `mtime` врёт в обе стороны: хук
 * (prettier, eslint --fix) переписывает файл сразу после агента и даёт
 * расхождение без участия человека; атомарное сохранение редактора, синхронизация
 * папки и `git checkout` — тоже. А на грубой файловой системе он, наоборот,
 * промолчит там, где правка была. Ложная тревога здесь дороже пропуска: она
 * приучает жать «дальше» не глядя, и настоящее предупреждение перестаёт
 * работать.
 *
 * ЛИПКИЙ ФЛАГ. Правка человека МЕЖДУ двумя правками агента не видна простым
 * сравнением: агент перезапишет файл, и наша запись обновится уже поверх. Но
 * такой файл остаётся спорным до конца сессии — рефакторинг это десяток правок
 * одного файла подряд, и вернуть его к состоянию трёхчасовой давности значит
 * снести и то, что человек дописал по дороге.
 */

export interface FileNote {
  /** Отпечаток того, что записал агент. */
  hash?: string
  /** Номер хода, на котором это случилось. */
  turn?: number
  /** Человек трогал этот файл в этой беседе — до конца сессии он спорный. */
  human?: boolean
}

/** Больше этого не помним на беседу: карта не должна расти без предела. */
const MAX_PATHS = 500

export class AgentFileMap {
  private map = new Map<string, Map<string, FileNote>>()

  /**
   * Один и тот же файл приходит к нам по-разному: движок называет путь с
   * прямыми слэшами, Windows — с обратными, а регистр диска у них свой у
   * каждого. Несовпадение ключа означало бы «мы про этот файл ничего не знаем»
   * там, где знаем всё, — то есть «не ручаемся» вместо предупреждения о потере
   * правки.
   */
  private key(path: string): string {
    const norm = path.split('\\').join('/')
    return process.platform === 'win32' ? norm.toLowerCase() : norm
  }

  private forConv(convId: string): Map<string, FileNote> {
    let m = this.map.get(convId)
    if (!m) {
      m = new Map()
      this.map.set(convId, m)
    }
    return m
  }

  /**
   * Перед правкой: если на диске уже НЕ то, что мы записали в прошлый раз, —
   * значит между правками агента файл трогал кто-то ещё.
   */
  async noteBefore(convId: string, path: string): Promise<void> {
    const m = this.forConv(convId)
    const prev = m.get(this.key(path))
    if (!prev?.hash) return
    const now = await fileHash(path)
    if (now && now !== prev.hash) {
      // Липко: агент сейчас перезапишет файл, и следующее сравнение уже ничего
      // не покажет — а спорным он останется до конца беседы.
      m.set(this.key(path), { ...prev, human: true })
    }
  }

  /** После правки: запоминаем, что записал агент. */
  async noteAfter(convId: string, path: string, turn?: number): Promise<void> {
    const m = this.forConv(convId)
    const k = this.key(path)
    if (!m.has(k) && m.size >= MAX_PATHS) return
    const prev = m.get(k)
    const hash = await fileHash(path)
    m.set(k, { ...prev, ...(hash ? { hash } : {}), ...(turn != null ? { turn } : {}) })
  }

  /** Что мы знаем об этом пути. */
  note(convId: string, path: string): FileNote | undefined {
    return this.map.get(convId)?.get(this.key(path))
  }

  /** Беседа закрыта — держать её карту незачем. */
  forget(convId: string): void {
    this.map.delete(convId)
  }

  /** Снимок карты для сохранения рядом с беседой. */
  dump(convId: string): Record<string, FileNote> {
    const out: Record<string, FileNote> = {}
    for (const [path, note] of this.map.get(convId) ?? []) out[path] = note
    return out
  }

  /** Поднять карту с диска: без неё карточка после перезапуска ничего не знает. */
  load(convId: string, data: Record<string, FileNote> | undefined): void {
    if (!data) return
    const m = this.forConv(convId)
    for (const [path, note] of Object.entries(data).slice(0, MAX_PATHS)) m.set(this.key(path), note)
  }
}

/**
 * Правку человека и правку агента различаем по содержимому.
 *
 * `observed:false` означает «мы про этот файл ничего не знаем» — и это НЕ
 * «всё в порядке»: карточка обязана сказать «не ручаемся», а не промолчать.
 */
export function compareNote(
  note: FileNote | undefined,
  diskHash: string | undefined
): { observed: boolean; changedAfterAgent: boolean } {
  if (!note?.hash) return { observed: false, changedAfterAgent: false }
  if (note.human) return { observed: true, changedAfterAgent: true }
  if (!diskHash) return { observed: true, changedAfterAgent: false }
  return { observed: true, changedAfterAgent: diskHash !== note.hash }
}

/**
 * Одна карта на приложение: у драйверов ключ беседы общий (requestId), а
 * заводить по карте на драйвер значило бы потерять правки, сделанные одной
 * панелью и увиденные другой.
 */
export const agentFiles = new AgentFileMap()
