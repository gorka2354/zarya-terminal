import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '@shared/types'
import { FILE_MODE, hardenFile } from './filePerms'

/** How much of the tail of history.jsonl to load on boot. */
const LOAD_TAIL_BYTES = 4 * 1024 * 1024
/**
 * Насколько файлу позволено перерасти потолок до уплотнения.
 *
 * Переписывать весь файл на каждой команде нельзя: при потолке в 20 000 записей
 * это мегабайты на каждый `ls`. Но и фиксированная «раз в 200 записей» не
 * годится — при потолке в 10 файл раздувался бы в двадцать раз. Запас берём
 * пропорциональным: не больше 10% от потолка, но и не чаще чем раз в 20
 * дописываний. Итог: файл никогда не превышает потолок больше чем на десятую
 * часть, а на больших значениях уплотнение остаётся редким.
 */
function compactSlack(limit: number): number {
  return Math.max(20, Math.ceil(limit * 0.1))
}

/**
 * Global cross-session command history ("Time Machine").
 * Append-only JSONL on disk; recent tail kept in memory for fuzzy search.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private appendQueue: Promise<void> = Promise.resolve()
  private loaded = false
  /** Настройки записи; до первого configure() ведём себя как раньше. */
  private record = true
  private maxEntries = 20000
  private sinceCompact = 0

  /**
   * Применить настройки. Вызывается при старте и на каждое изменение настроек:
   * выключенная запись должна прекращаться немедленно, а не со следующего
   * запуска — иначе выключатель не выключатель.
   */
  configure(opts: { record: boolean; maxEntries: number }): void {
    this.record = opts.record
    this.maxEntries = Math.max(0, Math.floor(opts.maxEntries))
    if (this.limit && this.entries.length > this.limit) {
      this.entries = this.entries.slice(-this.limit)
      void this.compact()
    }
  }

  /** Действующий потолок; 0 в настройках означает «без ограничения». */
  private get limit(): number {
    return this.maxEntries > 0 ? this.maxEntries : 0
  }

  private get file() {
    return join(app.getPath('userData'), 'history.jsonl')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const stat = await fs.stat(this.file)
      const start = Math.max(0, stat.size - LOAD_TAIL_BYTES)
      const fh = await fs.open(this.file, 'r')
      const buf = Buffer.alloc(stat.size - start)
      await fh.read(buf, 0, buf.length, start)
      await fh.close()
      const text = buf.toString('utf8')
      const lines = text.slice(text.indexOf('\n') + (start > 0 ? 1 : 0)).split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.entries.push(JSON.parse(line) as HistoryEntry)
        } catch {
          // skip corrupt line
        }
      }
      if (this.limit && this.entries.length > this.limit) {
        this.entries = this.entries.slice(-this.limit)
      }
      // Файл мог быть создан прошлой версией с правами по умолчанию: он только
      // дописывается и сам никогда не пересоздастся.
      await hardenFile(this.file)
    } catch {
      // no history yet
    }
  }

  /**
   * Переписать файл последними {@link limit} записями.
   *
   * Записи старше загруженного хвоста при этом теряются — это и есть смысл
   * потолка: без него файл рос бесконечно, а команды регулярно содержат
   * секреты. Пишем через временный файл и rename, чтобы падение посреди
   * уплотнения не оставило половину истории.
   */
  private async compact(): Promise<void> {
    if (!this.limit) return
    const keep = this.entries.slice(-this.limit)
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      const body = keep.map((e) => JSON.stringify(e)).join('\n')
      await fs.writeFile(tmp, body ? body + '\n' : '', {
        encoding: 'utf8',
        mode: FILE_MODE
      })
      await fs.rename(tmp, this.file)
      await hardenFile(this.file)
      this.sinceCompact = 0
    } catch {
      try {
        await fs.unlink(tmp)
      } catch {
        /* нечего убирать */
      }
    }
  }

  /** Стереть историю целиком — и в памяти, и на диске. */
  async clear(): Promise<{ ok: boolean }> {
    await this.ensureLoaded()
    this.entries = []
    this.sinceCompact = 0
    this.appendQueue = this.appendQueue.catch(() => {}).then(async () => {
      try {
        await fs.writeFile(this.file, '', { encoding: 'utf8', mode: FILE_MODE })
        await hardenFile(this.file)
      } catch {
        /* файла может и не быть */
      }
    })
    await this.appendQueue
    return { ok: true }
  }

  /** Сколько записей сейчас хранится и сколько весит файл. */
  async stats(): Promise<{ entries: number; bytes: number }> {
    await this.ensureLoaded()
    let bytes = 0
    try {
      bytes = (await fs.stat(this.file)).size
    } catch {
      /* файла нет */
    }
    return { entries: this.entries.length, bytes }
  }

  async add(entry: HistoryEntry): Promise<void> {
    // Проверка ДО загрузки файла: при выключенной записи история не должна даже
    // читаться с диска — иначе «не вести историю» означало бы только «не
    // дописывать», а старое всё равно попадало бы в поиск.
    if (!this.record) return
    await this.ensureLoaded()
    const cmd = entry.command.trim()
    if (!cmd) return
    this.entries.push(entry)
    if (this.limit && this.entries.length > this.limit) this.entries.shift()
    this.appendQueue = this.appendQueue
      .catch(() => {})
      .then(() =>
        // mode применяется только при СОЗДАНИИ файла; уже существующий с
        // прежними правами чинится отдельным chmod в ensureLoaded — сам он не
        // пересоздаётся никогда, потому что только дописывается.
        fs.appendFile(this.file, JSON.stringify(entry) + '\n', {
          encoding: 'utf8',
          mode: FILE_MODE
        })
      )
    await this.appendQueue
    // Уплотняем не на каждой команде: переписывать весь файл ради одной строки
    // дороже, чем изредка подержать на диске лишнюю сотню записей.
    if (this.limit && ++this.sinceCompact >= compactSlack(this.limit)) {
      this.appendQueue = this.appendQueue.catch(() => {}).then(() => this.compact())
      await this.appendQueue
    }
  }

  /**
   * Search history. Empty query returns recent unique commands.
   * Matching: every whitespace-separated token must appear in command or cwd.
   */
  async search(query: string, limit = 100): Promise<HistoryEntry[]> {
    await this.ensureLoaded()
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const seen = new Set<string>()
    const out: HistoryEntry[] = []
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i]
      const hay = (e.command + ' ' + e.cwd).toLowerCase()
      if (tokens.every((t) => hay.includes(t))) {
        const key = e.command.trim()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(e)
      }
    }
    return out
  }
}
