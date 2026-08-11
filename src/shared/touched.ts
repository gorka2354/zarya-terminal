import type { AiContentPart } from './types'

/**
 * Каких файлов агент касался — и с какого хода.
 *
 * Панель «что изменилось» показывает состояние рабочего дерева: git видит ВСЁ,
 * но не знает, кто это сделал. Здесь появляется вторая половина ответа — какие
 * из этих файлов трогал агент начиная с выбранного хода. Разница важна: одно
 * дело «файл изменился», другое — «его изменил агент вот на этом ходе», и
 * человек принимает по этим двум фактам разные решения.
 *
 * ПОЧЕМУ НЕ `isEditTool` И НЕ `editPreview`. Оба существуют для другого:
 * первый решает, накрывается ли вызов ступенью «правки без спроса» (и потому
 * намеренно исключает `mcp__*` — чужому серверу доверия нет), второй строит
 * ПОКАЗ построчной разницы. Здесь задача третья: узнать ПУТЬ. Для неё строгость
 * вредна — если файл записал MCP-сервер файловой системы, человеку всё равно
 * надо об этом знать, а «мы не поняли, что это была правка» превращается в
 * молчание там, где нужно предупреждение.
 */

/** Ключи, которыми инструменты называют файл. Порядок — по частоте. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'filename', 'file']

/**
 * Путь, которого касается вызов инструмента, — или null, если вызов не про файл.
 *
 * Читающие инструменты (`Read`, `Grep`, `Glob`) исключены намеренно: они не
 * меняют файл, а пометка «агент трогал» рядом с чужой правкой человека была бы
 * ложным обвинением — и, что хуже, ложным успокоением в обратную сторону.
 */
export function toolPath(name: unknown, input: unknown): string | null {
  if (typeof name !== 'string' || !name) return null
  if (READ_ONLY.has(name.toLowerCase())) return null
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/** Инструменты, которые только читают: путь у них есть, а правки нет. */
const READ_ONLY = new Set(['read', 'grep', 'glob', 'ls', 'notebookread', 'view'])

export interface TouchedTurn {
  /** Индекс сообщения человека, с которого считаем. */
  from: number
  paths: string[]
}

/**
 * Пути, тронутые начиная с сообщения `from` и до конца беседы.
 *
 * Считаем именно «с хода и дальше», а не «за один ход»: человек спрашивает
 * «что он натворил, пока делал вот это», и работа обычно растекается на
 * несколько ходов подряд.
 */
export function touchedSince(
  messages: Array<{ role: string; content: AiContentPart[] }>,
  from: number
): string[] {
  const out = new Set<string>()
  for (let i = Math.max(0, from); i < messages.length; i++) {
    for (const part of messages[i]?.content ?? []) {
      if (part.type !== 'tool_use') continue
      const p = toolPath(part.name, part.input)
      if (p) out.add(p)
    }
  }
  return [...out]
}

/**
 * Пути в списке git — относительные корню репозитория; агент называет свои
 * абсолютными (а фейки и часть движков — относительными рабочей папке). Чтобы
 * сопоставить одно с другим, всё приводится к «относительно корня».
 *
 * Регистр: сравниваем без учёта регистра только там, где путь windows-подобный
 * (есть буква диска). На Linux `a.ts` и `A.ts` — разные файлы, и приравнивать
 * их значило бы пометить чужой файл как тронутый агентом.
 */
export function relativeToRoot(path: string, root: string, cwd?: string): string | null {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const p0 = norm(path)
  const r = norm(root)
  if (!r) return null
  const ci = /^[a-zA-Z]:/.test(r)
  const eq = (a: string, b: string): boolean => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
  // Относительный путь — сначала достраиваем рабочей папкой движка, иначе
  // «src/a.ts» из панели в другой папке совпал бы с чужим «src/a.ts».
  const abs = /^([a-zA-Z]:\/|\/)/.test(p0) ? p0 : norm(`${cwd || r}/${p0}`)
  if (eq(abs, r)) return ''
  const prefix = r.endsWith('/') ? r : `${r}/`
  if (!eq(abs.slice(0, prefix.length), prefix)) return null
  return abs.slice(prefix.length)
}

export interface TouchedMatch {
  /** Пути (относительные корню), которые агент трогал — для пометки в списке. */
  inRepo: Set<string>
  /**
   * Файлы, которых агент касался, но git о них не говорит: они вне
   * репозитория, под `.gitignore` или уже вернулись к состоянию коммита.
   * Молчать о них нельзя — радиус работы агента шире одного репозитория, и
   * именно там живут неприятные сюрпризы вроде правки в чужом проекте.
   */
  outside: string[]
}

export function matchTouched(
  touched: string[],
  root: string,
  cwd: string,
  known: Iterable<string>
): TouchedMatch {
  const ci = /^[a-zA-Z]:/.test(root.replace(/\\/g, '/'))
  const key = (s: string): string => (ci ? s.toLowerCase() : s)
  const list = [...known]
  const knownSet = new Set(list.map(key))
  // Схлопнутые каталоги: `git status` отдаёт новую папку одной строкой `src/`
  // и не перечисляет файлы внутри. Без этого совпадения файл, который агент
  // только что создал в новой папке, остался бы НЕ помеченным — то есть панель
  // показала бы работу агента как чью-то чужую.
  const dirs = list.filter((p) => p.endsWith('/'))
  const inRepo = new Set<string>()
  const outside: string[] = []
  for (const p of touched) {
    const rel = relativeToRoot(p, root, cwd)
    if (rel === null) {
      outside.push(p)
      continue
    }
    if (knownSet.has(key(rel))) {
      inRepo.add(rel)
      continue
    }
    const dir = dirs.find((d) => key(rel).startsWith(key(d)))
    if (dir) inRepo.add(dir)
  }
  return { inRepo, outside }
}
