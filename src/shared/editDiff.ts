/**
 * Что именно агент собирается изменить в файле.
 *
 * Карточка одобрения просит разрешить правку — и обязана эту правку показать.
 * Для команды это правило уже соблюдается (текст команды разворачивается и не
 * сворачивается, пока гейт ждёт решения), а для `Edit` / `Write` на экране был
 * только путь: человек одобрял вслепую.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ — номеров строк. Вызов приносит `old_string` и
 * `new_string`, то есть ФРАГМЕНТЫ файла, а не его целиком: где эти строки
 * стоят, мы не знаем. Нарисовать «118–124» было бы правдоподобно и неправдиво,
 * поэтому нумерации нет вовсе.
 *
 * И `Write` тоже честен: старого текста в вызове нет, сравнивать не с чем, а
 * читать файл с диска ради сравнения значило бы лезть в файловую систему из
 * карточки одобрения. Показываем то, что записывают, и говорим, что это запись
 * целиком.
 */

export type DiffLineKind = 'add' | 'del' | 'ctx'
export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface EditPreview {
  /** Как показывать: построчный дифф или «записывается целиком». */
  kind: 'diff' | 'write'
  /** Файл, которого касается правка (может быть пустым — тогда его назовёт подпись карточки). */
  path: string
  /** Строки для показа. Для 'write' — всё содержимое как добавленное. */
  lines: DiffLine[]
  added: number
  removed: number
  /** Правка не поместилась в разумный предел — строки обрезаны. */
  truncated?: boolean
  /** Сколько отдельных кусков было (MultiEdit). 1 — обычная правка. */
  chunks?: number
}

/** Больше этого не разбираем построчно: подсказка не стоит секунды на перерисовку. */
const MAX_LINES = 400
/** Столько строк показываем максимум — остальное честно помечаем обрезанным. */
const MAX_SHOWN = 300

function split(text: string): string[] {
  // Хвостовой перевод строки не создаёт «пустую строку» в глазах человека.
  const t = text.replace(/\r\n/g, '\n')
  const lines = t.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Построчная разница двух фрагментов.
 *
 * Обычный LCS по строкам: правки в вызове небольшие (это кусок файла, а не файл),
 * и точность здесь важнее скорости. На больших кусках честно сдаёмся — см. MAX_LINES.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = split(before)
  const b = split(after)
  if (a.length + b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text }))
    ]
  }
  // dp[i][j] — длина наибольшей общей подпоследовательности хвостов.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

interface RawEdit {
  old_string?: unknown
  new_string?: unknown
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Разобрать вызов инструмента в то, что можно показать.
 *
 * Возвращает `null` для всего, что правкой файла не является: карточка тогда
 * остаётся прежней. Имена инструментов сравниваются без учёта регистра и
 * возможного префикса движка — у разных агентов они пишутся по-своему.
 */
export function editPreview(name: string, input: unknown): EditPreview | null {
  const n = (name || '').toLowerCase().replace(/^.*__/, '')
  const o = input as
    | { file_path?: unknown; path?: unknown; content?: unknown; edits?: unknown }
    | null
    | undefined
  if (!o || typeof o !== 'object') return null
  const path = asText(o.file_path) || asText(o.path)

  // Запись целиком: сравнивать не с чем — в вызове нет старого текста.
  if (n === 'write' && typeof o.content === 'string') {
    const lines = split(o.content).map((text) => ({ kind: 'add' as const, text }))
    return {
      kind: 'write',
      path,
      lines: lines.slice(0, MAX_SHOWN),
      added: lines.length,
      removed: 0,
      truncated: lines.length > MAX_SHOWN
    }
  }

  // Несколько правок одним вызовом — показываем подряд, помечая число кусков.
  if ((n === 'multiedit' || n === 'multi_edit') && Array.isArray(o.edits)) {
    const all: DiffLine[] = []
    let chunks = 0
    for (const raw of o.edits as RawEdit[]) {
      const before = asText(raw?.old_string)
      const after = asText(raw?.new_string)
      if (!before && !after) continue
      if (chunks) all.push({ kind: 'ctx', text: '' })
      all.push(...lineDiff(before, after))
      chunks++
    }
    if (!chunks) return null
    return summarize({ kind: 'diff', path, lines: all, added: 0, removed: 0, chunks })
  }

  if (n === 'edit') {
    const before = asText((o as RawEdit).old_string)
    const after = asText((o as RawEdit).new_string)
    if (!before && !after) return null
    return summarize({ kind: 'diff', path, lines: lineDiff(before, after), added: 0, removed: 0 })
  }

  return null
}

function summarize(p: EditPreview): EditPreview {
  const added = p.lines.filter((l) => l.kind === 'add').length
  const removed = p.lines.filter((l) => l.kind === 'del').length
  return {
    ...p,
    added,
    removed,
    lines: p.lines.slice(0, MAX_SHOWN),
    truncated: p.lines.length > MAX_SHOWN
  }
}
