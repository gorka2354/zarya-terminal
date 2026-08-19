/**
 * Поиск по командам панели — чистой функцией, отдельно от хранилища.
 *
 * ПОЧЕМУ ОТДЕЛЬНО. Сначала он жил прямо в обработчике запроса окна, и ревью
 * нашло там сразу три разных дефекта: отрывок резался от начала строки (при
 * длинном однострочном логе агент получал двести знаков БЕЗ искомого),
 * `split('\n')` разбирал весь вывод целиком синхронно в главном потоке окна, а
 * проверить всё это было нечем — обработчик тянет за собой хранилища, окно и
 * мост. Правила поиска — чистая арифметика над строками; здесь их видно и
 * можно проверить.
 *
 * ЧТО ЭТО НЕ ЕСТЬ. Не полнотекстовый поиск: ни регулярных выражений, ни
 * подсветки, ни ранжирования. Ответ на вопрос «где я это видел» — несколько
 * последних команд, у каждой одна совпавшая строка. За полным выводом есть
 * отдельный вызов со своей карточкой разрешения.
 */

/** То, по чему ищем: команда и её сохранённый вывод. */
export interface SearchableBlock {
  id: string
  command: string
  output?: string
}

/** Что нашлось в одном блоке. */
export interface BlockMatch {
  id: string
  /**
   * Сколько СТРОК вывода совпало.
   *
   * Ноль значит «совпало в самой команде, а в выводе нет» — и это разные
   * ответы: во втором случае отрывку взяться неоткуда, и выдумывать его нельзя.
   */
  matches: number
  /** Первая совпавшая строка, обрезанная ОКНОМ ВОКРУГ совпадения. */
  snippet?: string
}

/**
 * Сколько блоков просматриваем вглубь.
 *
 * Верхняя граница хранилища — сотни блоков по сотне килобайт вывода каждый, и
 * проход по ним идёт синхронно в потоке окна, пока главный процесс ждёт ответа
 * с таймаутом. «Где я это видел» — вопрос про недавнее; глубина названа числом,
 * а не оставлена на «сколько накопится».
 */
export const SEARCH_DEPTH = 120

/**
 * Найти команды, где встречается искомое.
 *
 * Идём от последних к первым: свежее важнее. Регистр не различаем — человек
 * ищет «econnrefused», а в логе `ECONNREFUSED`.
 */
export function searchBlocks(
  blocks: readonly SearchableBlock[],
  needle: string,
  opts: { hits: number; cap: number; depth?: number } = { hits: 5, cap: 200 }
): BlockMatch[] {
  const low = (needle ?? '').trim().toLowerCase()
  if (!low) return []
  const hits = Math.max(1, opts.hits)
  const cap = Math.max(20, opts.cap)
  const depth = Math.max(1, opts.depth ?? SEARCH_DEPTH)

  const found: BlockMatch[] = []
  const from = Math.max(0, blocks.length - depth)
  for (let i = blocks.length - 1; i >= from && found.length < hits; i--) {
    const b = blocks[i]
    if (!b) continue
    const out = b.output ?? ''
    const hay = out.toLowerCase()
    /*
     * СЧИТАЕМ СТРОКИ, А НЕ ВХОЖДЕНИЯ, и не разбираем вывод на массив.
     *
     * После каждого совпадения прыгаем на следующую строку: два вхождения в
     * одной строке — одна совпавшая строка, и «совпадений: 2» вводило бы в
     * заблуждение ровно там, где агент решает, читать ли блок целиком.
     */
    let at = hay.indexOf(low)
    let count = 0
    const first = at
    while (at >= 0) {
      count++
      const nl = hay.indexOf('\n', at)
      if (nl < 0) break
      at = hay.indexOf(low, nl + 1)
    }
    const inCommand = (b.command ?? '').toLowerCase().includes(low)
    if (!count && !inCommand) continue
    found.push({
      id: b.id,
      matches: count,
      ...(count ? { snippet: windowAround(out, first, low.length, cap) } : {})
    })
  }
  return found.reverse()
}

/**
 * Отрывок ВОКРУГ совпадения, а не от начала строки.
 *
 * Ревью поймало: `slice(0, 200)` на однострочном JSON или длинной строке лога
 * отдавал агенту двести знаков, в которых искомого нет вовсе, — и он читал это
 * как «нашлось вот это». Берём окно с обеих сторон и honestly помечаем срез
 * многоточием с той стороны, с которой обрезали.
 */
function windowAround(text: string, at: number, len: number, cap: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, at - 1)) + 1
  const lineEndRaw = text.indexOf('\n', at)
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw
  const line = text.slice(lineStart, lineEnd).replace(/\r$/, '')
  if (line.length <= cap) return line

  const hitAt = at - lineStart
  // Половина окна слева от совпадения, остальное справа — так виден и контекст
  // перед ним, и продолжение.
  const before = Math.max(0, Math.floor((cap - len) / 2))
  let start = Math.max(0, hitAt - before)
  let end = start + cap
  if (end > line.length) {
    end = line.length
    start = Math.max(0, end - cap)
  }
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/**
 * Какой блок имеет в виду вызов `read_block`.
 *
 * `last` — самый свежий: без него самый частый случай («покажи, что сейчас
 * упало») стоил лишнего вызова, лишней карточки и лишнего хода.
 *
 * ЖИВЁТ ЗДЕСЬ, ПОТОМУ ЧТО У ЭТОГО ПРАВИЛА ТРИ ЧИТАТЕЛЯ: карточка разрешения
 * (показать человеку, какую команду читают), закрепление выбора при одобрении
 * и само чтение. Разойдись они — и карточка называла бы одну команду, а агент
 * получал бы другую; это ровно то враньё, ради предотвращения которого
 * «last» и делался так осторожно.
 */
export function blockForId<T extends { id: string }>(
  blocks: readonly T[],
  id: string
): T | undefined {
  const want = (id ?? '').trim()
  if (!want) return undefined
  if (want.toLowerCase() === 'last') return blocks[blocks.length - 1]
  return blocks.find((b) => b.id === want)
}
