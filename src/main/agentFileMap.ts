import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { fileHash } from './rewindFacts'
import { readJson, writeJsonAtomic } from './jsonStore'

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
  /**
   * Ход, на котором агент СОЗДАЛ этот файл (id хода человека).
   *
   * Ради одного значка — «БУДЕТ УДАЛЁН». Откат двунаправленный: файл,
   * появившийся после выбранного хода, он не возвращает, а стирает. Без этой
   * записи такой файл показывался бы спокойным «вернётся к прежнему виду» и
   * исчезал бы вместе со всем, что человек в него дописал.
   */
  createdTurnId?: string
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

  /**
   * После правки: запоминаем, что записал агент.
   *
   * `createdTurnId` ставится ровно один раз — на том ходе, где файла ДО правки
   * не было. Перезаписывать его нельзя: файл создан однажды, и именно эта точка
   * решает, удалит его откат или вернёт.
   */
  async noteAfter(
    convId: string,
    path: string,
    o?: { turn?: number; createdTurnId?: string }
  ): Promise<void> {
    const m = this.forConv(convId)
    const k = this.key(path)
    if (!m.has(k) && m.size >= MAX_PATHS) return
    const prev = m.get(k)
    const hash = await fileHash(path)
    m.set(k, {
      ...prev,
      ...(hash ? { hash } : {}),
      ...(o?.turn != null ? { turn: o.turn } : {}),
      ...(o?.createdTurnId && !prev?.createdTurnId ? { createdTurnId: o.createdTurnId } : {})
    })
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
  diskHash: string | undefined,
  /** Файл существует на диске. Нужен, чтобы отличить «нет файла» от «не прочли». */
  existsNow = true
): { observed: boolean; changedAfterAgent: boolean } {
  if (!note?.hash) return { observed: false, changedAfterAgent: false }
  if (note.human) return { observed: true, changedAfterAgent: true }
  if (!diskHash) {
    /*
     * Файл есть, а прочитать его мы не смогли (занят, нет прав, ссылка).
     * Сказать «вернётся к прежнему виду» тут нельзя: мы не знаем, что в нём.
     * Возвращаем «не наблюдали» — карточка честно скажет «не ручаемся», и файл
     * попадёт в страховочную копию.
     */
    return { observed: !existsNow, changedAfterAgent: false }
  }
  return { observed: true, changedAfterAgent: diskHash !== note.hash }
}

/** Больше этого числа бесед не храним: файл не должен расти сам по себе. */
const MAX_CONVS = 60

type MapFile = Record<string, { at: number; files: Record<string, FileNote> }>

/**
 * Карта переживает перезапуск — иначе она бесполезна ровно в самом частом
 * случае.
 *
 * Вечером правил агент, ночью человек поправил файл руками, утром Заря
 * открывается заново. Без сохранённой карты карточка отката не может отличить
 * «файл вернётся к прежнему виду» от «ты потеряешь свою правку» и честно
 * говорит «не ручаемся» — то есть теряет главное, ради чего затевалась.
 *
 * Файл маленький и ограниченный: путь → отпечаток и номер хода, не больше
 * MAX_PATHS путей на беседу и не больше MAX_CONVS бесед. Старшее по времени
 * выбывает — это не архив, а рабочая память.
 */
export class AgentFileStore {
  private get file(): string {
    return join(app.getPath('userData'), 'agent-files.json')
  }

  private cache: MapFile | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Беседы, чья карта ещё не на диске.
   *
   * Отложенная запись экономит диск, но при закрытии приложения последние
   * правки просто не успевали сохраниться — и наутро карточка отката честно
   * говорила «не ручаемся» о файле, про который всё знала вчера. Найдено
   * прогоном перезапуска.
   */
  private dirty = new Set<string>()

  private async read(): Promise<MapFile> {
    if (!this.cache) this.cache = await readJson<MapFile>(this.file, {})
    return this.cache
  }

  /** Поднять карту беседы с диска (при первом обращении к ней). */
  async restore(map: AgentFileMap, convId: string): Promise<void> {
    const all = await this.read()
    map.load(convId, all[convId]?.files)
  }

  /**
   * Отложенная запись: правок за ход бывает десяток, и писать файл на каждую
   * значит трогать диск ради того, что через секунду перезапишется.
   */
  schedule(map: AgentFileMap, convId: string): void {
    this.dirty.add(convId)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flushAll(map)
    }, 800)
  }

  /**
   * Дописать всё несохранённое СИНХРОННО — на выходе из приложения.
   *
   * Асинхронная запись здесь не годится: процесс умирает раньше, чем она
   * доходит до диска, и правки последней минуты пропадают. Проверено прогоном
   * перезапуска — файла карты просто не оказывалось.
   */
  flushAllSync(map: AgentFileMap): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    /*
     * Кеш может быть ПУСТ: если за этот запуск карту ни разу не читали, а
     * правка была, `this.cache` остаётся null — и запись затёрла бы карты всех
     * прочих бесед. Поэтому читаем файл синхронно и сливаем поверх.
     */
    let all: MapFile = this.cache ?? {}
    if (!this.cache) {
      try {
        all = JSON.parse(readFileSync(this.file, 'utf8')) as MapFile
      } catch {
        all = {}
      }
    }
    for (const id of this.dirty) {
      const files = map.dump(id)
      if (Object.keys(files).length) all[id] = { at: Date.now(), files }
      else delete all[id]
    }
    this.dirty.clear()
    // Тот же кап, что и на обычном пути: выход не повод растить файл без предела.
    const ids = Object.keys(all)
    if (ids.length > MAX_CONVS) {
      ids
        .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
        .slice(0, ids.length - MAX_CONVS)
        .forEach((id) => delete all[id])
    }
    this.cache = all
    try {
      writeFileSync(this.file, JSON.stringify(all), 'utf8')
    } catch {
      /* на выходе жаловаться некому */
    }
  }

  /** Дописать всё несохранённое — вызывается на выходе из приложения. */
  async flushAll(map: AgentFileMap): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) await this.flush(map, id)
  }

  async flush(map: AgentFileMap, convId: string): Promise<void> {
    const all = await this.read()
    const files = map.dump(convId)
    if (Object.keys(files).length) all[convId] = { at: Date.now(), files }
    else delete all[convId]
    // Кап по числу бесед: самые старые выбывают. Иначе файл растёт всю жизнь
    // приложения, а обещание «не оставляем мусор» держится на честном слове.
    const ids = Object.keys(all)
    if (ids.length > MAX_CONVS) {
      ids
        .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
        .slice(0, ids.length - MAX_CONVS)
        .forEach((id) => delete all[id])
    }
    this.cache = all
    await writeJsonAtomic(this.file, all)
  }

  /** Беседа удалена — её карту тоже. */
  async forget(convId: string): Promise<void> {
    const all = await this.read()
    if (!(convId in all)) return
    delete all[convId]
    this.cache = all
    await writeJsonAtomic(this.file, all)
  }
}

export const agentFileStore = new AgentFileStore()

/**
 * Одна карта на приложение: у драйверов ключ беседы общий (requestId), а
 * заводить по карте на драйвер значило бы потерять правки, сделанные одной
 * панелью и увиденные другой.
 */
export const agentFiles = new AgentFileMap()
