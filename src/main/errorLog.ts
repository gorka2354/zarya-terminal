import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Журнал сбоев — единственное место, куда Заря пишет «что сломалось».
 *
 * ПОВОД. Упавшая отрисовка снимала всё окно, и от аварии не оставалось НИЧЕГО:
 * ни строки на экране, ни файла на диске. Человек видел пустой прямоугольник и
 * не мог ни понять причину, ни рассказать о ней. Кнопка «сообщить об ошибке»
 * при этом вела на главную страницу репозитория — то есть предлагала написать
 * то, чего он не знает.
 *
 * ЧТО СЮДА ПИШЕТСЯ: сорванная отрисовка, необработанное исключение окна и
 * необработанный отказ обещания. Не телеметрия и не «диагностика»: файл лежит
 * в папке данных на этой машине, никуда не отправляется и открывается кнопкой.
 *
 * ЗАРЯ НЕ ОСТАВЛЯЕТ МУСОРА. У файла есть предел; переполнившись, он становится
 * `errors.1.log` и начинается заново. Двух поколений достаточно: авария,
 * случившаяся два файла назад, уже не про сегодняшнюю сборку.
 */

/** Полмегабайта — это тысячи строк стека и всё ещё мгновенное открытие. */
const MAX_BYTES = 512 * 1024

function logDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Путь к текущему журналу — его же показывает кнопка «показать журнал». */
export function errorLogPath(): string {
  return join(logDir(), 'errors.log')
}

/**
 * Записать одну аварию.
 *
 * Пишем СИНХРОННО и молча глотаем свои же ошибки: журнал зовут из обработчика
 * сбоя, и падение внутри падения не должно стать вторым сбоем поверх первого.
 */
export function logError(text: string): void {
  try {
    const file = errorLogPath()
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, join(logDir(), 'errors.1.log'))
    } catch {
      /* файла ещё нет — значит и вращать нечего */
    }
    const stamp = new Date().toISOString()
    appendFileSync(file, `\n=== ${stamp} · Zarya ${app.getVersion()}\n${text}\n`, 'utf8')
  } catch {
    /* журнал — не повод падать ещё раз */
  }
}

/**
 * Поймать то, что иначе исчезает бесследно, — в ГЛАВНОМ процессе.
 *
 * Здесь необработанное исключение обычно валит всё приложение целиком, и без
 * записи от него не остаётся даже имени.
 */
export function installMainErrorLog(): void {
  process.on('uncaughtException', (e) => {
    logError(`main: uncaughtException\n${e?.stack ?? String(e)}`)
  })
  process.on('unhandledRejection', (r) => {
    logError(`main: unhandledRejection\n${r instanceof Error ? (r.stack ?? r.message) : String(r)}`)
  })
}
