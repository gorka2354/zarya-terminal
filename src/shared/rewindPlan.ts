/**
 * Что именно произойдёт с каждым файлом при откате — до того, как он произойдёт.
 *
 * Сам вызов отката — десяток строк; весь инкремент существует ради ЭТОГО
 * списка. Родной механизм движка молчит о трёх вещах, каждая из которых
 * проверена живым прогоном:
 *
 * 1) он молча затирает ручные правки в файлах, которых касался агент — сухой
 *    прогон об этом не предупреждает вовсе;
 * 2) он ходит за пределы папки панели, по любым путям, которых касался агент
 *    (в прогоне удалил и воссоздал файл в чужом проекте на рабочем столе);
 * 3) он двунаправленный: файл, созданный после выбранного хода, будет НЕ
 *    возвращён, а удалён. Слово «вернётся» напротив такого файла — враньё в
 *    самом дорогом месте.
 *
 * Поэтому здесь не три взаимоисключающие группы, а НАБОР ЗНАЧКОВ у каждого
 * файла: файл в чужом проекте, который человек правил вчера, обязан показать
 * оба признака сразу. Группы прятали бы самое опасное за самым заметным.
 *
 * Функция чистая: живые прогоны с настоящим движком CI не гоняет, а ошибка
 * здесь стоит чужой работы.
 */

/** Что мы знаем о файле к моменту показа карточки. */
export interface FileFacts {
  /** Путь, как его назвал движок (абсолютный). */
  path: string
  /** Файл есть на диске прямо сейчас. */
  existsNow: boolean
  /** Агент создал его ПОСЛЕ выбранного хода — значит откат его удалит. */
  createdAfterTurn?: boolean
  /** Содержимое на диске разошлось с тем, что записал агент. */
  changedAfterAgent?: boolean
  /** У нас вообще есть своя запись об этом файле. */
  observed?: boolean
  /** Путь вне рабочей папки агента. */
  outsideCwd?: boolean
  /** В этом файле работает другая живая панель — и она об откате не узнает. */
  heldByPane?: string
  /** Симлинк, хардлинк или не обычный файл: движок такой путь пропустит. */
  linkSkipped?: boolean
  /** Файл открыт в редакторе Зари с несохранёнными правками. */
  dirtyInEditor?: boolean
}

export type RewindMark =
  /** БУДЕТ УДАЛЁН — создан после этого хода. */
  | 'will-delete'
  /** Будет создан заново — сейчас его нет, а на ход он был. */
  | 'will-create'
  /** Правили после хода — правка пропадёт. */
  | 'edited-after'
  /** Не сохранено в редакторе Зари. */
  | 'dirty-editor'
  /** Не ручаемся: своей записи об этом файле нет. */
  | 'unobserved'
  /** Вне папки агента. */
  | 'outside'
  /** Держит другая панель. */
  | 'neighbor'
  /** Откат этот путь пропустит (ссылка). */
  | 'skip-link'
  /** Вернётся к прежнему виду — ничего тревожного не нашли. */
  | 'restore'

/**
 * Вес значка = цена ошибки, если человек его не заметит.
 *
 * Потеря несохранённой работы дороже удаления файла, который агент только что
 * создал; «не ручаемся» дороже спокойного «вернётся», потому что за ним может
 * скрываться и то и другое.
 */
const WEIGHT: Record<RewindMark, number> = {
  'edited-after': 100,
  'dirty-editor': 95,
  'will-delete': 90,
  neighbor: 80,
  unobserved: 70,
  outside: 60,
  'skip-link': 50,
  'will-create': 20,
  restore: 0
}

export interface RewindRow {
  path: string
  marks: RewindMark[]
  /** Наибольший вес значка — по нему сортируется список. */
  danger: number
  /** Имя соседней панели, если файл держит она. */
  pane?: string
}

export interface RewindSummary {
  total: number
  willDelete: number
  willCreate: number
  editedAfter: number
  unobserved: number
  outside: number
  neighbor: number
  skipLink: number
  /** Есть хоть один файл, из-за которого стоит остановиться и подумать. */
  risky: boolean
}

export interface RewindView {
  rows: RewindRow[]
  summary: RewindSummary
}

export function marksFor(f: FileFacts): RewindMark[] {
  const out: RewindMark[] = []
  // Порядок внутри файла — от «что произойдёт» к «чем это грозит»: человек
  // читает строку слева направо и первым должен увидеть действие.
  if (f.createdAfterTurn && f.existsNow) out.push('will-delete')
  else if (!f.existsNow) out.push('will-create')

  if (f.changedAfterAgent) out.push('edited-after')
  if (f.dirtyInEditor) out.push('dirty-editor')
  // «Не ручаемся» и «правку видели» — взаимоисключающие: если своей записи нет,
  // мы не можем ни обвинить, ни успокоить.
  if (!f.observed && !f.changedAfterAgent) out.push('unobserved')
  if (f.outsideCwd) out.push('outside')
  if (f.heldByPane) out.push('neighbor')
  if (f.linkSkipped) out.push('skip-link')

  // Спокойное «вернётся» ставим только когда сказать больше нечего.
  if (!out.length) out.push('restore')
  return out
}

export function rewindPlan(facts: FileFacts[]): RewindView {
  const rows: RewindRow[] = facts.map((f) => {
    const marks = marksFor(f)
    return {
      path: f.path,
      marks,
      danger: Math.max(...marks.map((m) => WEIGHT[m])),
      ...(f.heldByPane ? { pane: f.heldByPane } : {})
    }
  })
  rows.sort((a, b) => b.danger - a.danger || a.path.localeCompare(b.path))

  const has = (r: RewindRow, m: RewindMark): boolean => r.marks.includes(m)
  const summary: RewindSummary = {
    total: rows.length,
    willDelete: rows.filter((r) => has(r, 'will-delete')).length,
    willCreate: rows.filter((r) => has(r, 'will-create')).length,
    editedAfter: rows.filter((r) => has(r, 'edited-after')).length,
    unobserved: rows.filter((r) => has(r, 'unobserved')).length,
    outside: rows.filter((r) => has(r, 'outside')).length,
    neighbor: rows.filter((r) => has(r, 'neighbor')).length,
    skipLink: rows.filter((r) => has(r, 'skip-link')).length,
    risky: false
  }
  // «Стоит остановиться» — это потеря чужой работы или удаление файла. Ссылки и
  // «вернётся заново» сюда не входят: они неприятны, но ничего не уничтожают.
  summary.risky =
    summary.editedAfter > 0 ||
    summary.willDelete > 0 ||
    summary.neighbor > 0 ||
    summary.unobserved > 0 ||
    rows.some((r) => has(r, 'dirty-editor'))
  return { rows, summary }
}

/**
 * Движок ответил, что откатить можно, но списка файлов не дал.
 *
 * Показать пустой список нельзя: он читается как «ничего не изменится», то
 * есть как знание, которого у нас нет.
 */
export function noFileList(files: string[] | undefined | null): boolean {
  return !files || files.length === 0
}
