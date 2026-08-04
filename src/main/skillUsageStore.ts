import { app } from 'electron'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './jsonStore'
import {
  noteUsage,
  summarize,
  type SkillUsageFile,
  type SkillUsageSummary
} from '@shared/skillUsage'

/**
 * Счётчик срабатываний скиллов — в данных Зари, и ТОЛЬКО там.
 *
 * Никуда не отправляется: файл нужен, чтобы ответить человеку на его же
 * вопрос — «за что я плачу, если оно не работает». Ни запросов, ни ответов, ни
 * путей внутри нет, только имена его собственных скиллов и счётчики по дням.
 *
 * Запись отложенная: скиллы срабатывают пачками внутри одного хода, и писать
 * файл на каждое срабатывание значило бы дёргать диск ради счётчика.
 */
export class SkillUsageStore {
  private get file(): string {
    return join(app.getPath('userData'), 'skill-usage.json')
  }

  private cache: SkillUsageFile | null = null
  private pending: string[] = []
  private timer: NodeJS.Timeout | undefined

  private async read(): Promise<SkillUsageFile> {
    if (!this.cache) {
      const raw = await readJson<SkillUsageFile>(this.file, { since: 0, days: {} })
      this.cache = raw && typeof raw === 'object' && raw.days ? raw : { since: 0, days: {} }
    }
    return this.cache
  }

  /** Записать срабатывания. Сбрасывается на диск пачкой, а не по одному. */
  note(names: string[]): void {
    const clean = names.filter((n) => typeof n === 'string' && n.trim())
    if (!clean.length) return
    this.pending.push(...clean)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 1500)
  }

  /** Слить накопленное на диск. Зовётся по таймеру и при выходе. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const names = this.pending
    if (!names.length) return
    this.pending = []
    const next = noteUsage(await this.read(), names, Date.now())
    this.cache = next
    await writeJsonAtomic(this.file, next)
  }

  /** Сводка для окна: сколько раз что сработало и сколько дней мы смотрим. */
  async summary(): Promise<SkillUsageSummary> {
    // Сначала дописываем висящее: иначе только что сработавший скилл выглядел
    // бы не сработавшим — ровно в тот момент, когда человек на него смотрит.
    await this.flush()
    return summarize(await this.read(), Date.now())
  }

  /** Забыть всё. Человек вправе обнулить наблюдение, не копаясь в файлах. */
  async clear(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending = []
    // `since` = сейчас, а не ноль: наблюдение начинается заново с этой минуты, и
    // «ни разу за 1 день» честнее, чем «ни разу за 30».
    this.cache = { since: Date.now(), days: {} }
    await writeJsonAtomic(this.file, this.cache)
  }
}
