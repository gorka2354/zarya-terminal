/**
 * Аргументы вызова, пока модель их ещё печатает.
 *
 * Посимвольно в Заре шёл только текст ответа. Когда модель сочиняет ВЫЗОВ
 * инструмента, текста нет вовсе — и на экране оставались три точки: секунду,
 * пять, десять, если команда длинная. Отличить «пишет команду» от «завис» было
 * нельзя, то есть повторялась ровно та беда, ради которой печать ответа и
 * заводили.
 *
 * Движок в это время присылает `input_json_delta` — куски JSON аргументов. JSON
 * заведомо НЕДОПИСАН: `{"command": "npm run bu`. Разобрать его нечем, а ждать
 * закрывающей скобки значит опять показывать точки.
 *
 * Поэтому здесь не разбор, а вычитывание одного значения — того, которое человек
 * и увидит потом в карточке. Всё, что вернёт эта функция, живёт секунды и тут же
 * заменяется настоящей карточкой: цена ошибки — мигнувшая строка, а не неверная
 * запись в беседе. Но и врать ей незачем, поэтому ключ ищется только там, где он
 * может быть ключом, — сразу после `{` или запятой, а не внутри чужой строки.
 */

/**
 * Что показываем, по убыванию полезности. Порядок повторяет `toolLabel`: человек
 * должен увидеть на печати то же самое поле, что потом прочтёт в карточке.
 */
const KEYS = [
  'skill',
  'command',
  'query',
  'url',
  'pattern',
  'description',
  'subject',
  'file_path',
  'path',
  'prompt'
]

/** Длиннее этого превью не нужно: это строка на один взгляд, а не содержимое. */
const MAX = 160

/**
 * Достать читаемое значение из недописанного JSON. Пусто — показывать нечего.
 */
export function partialArg(json: string): string {
  if (!json) return ''
  for (const key of KEYS) {
    const v = valueOf(json, key)
    if (v) return v
  }
  return ''
}

/** Значение строкового поля — даже если строка ещё не закрыта. */
function valueOf(json: string, key: string): string {
  const at = keyIndex(json, key)
  if (at < 0) return ''
  let i = at + key.length + 2 // за закрывающей кавычкой имени
  while (i < json.length && /\s/.test(json[i])) i++
  if (json[i] !== ':') return ''
  i++
  while (i < json.length && /\s/.test(json[i])) i++
  // Нестроковое значение (число, объект, массив) показывать нечем: превью — это
  // строка для человека, а не дамп аргументов.
  if (json[i] !== '"') return ''
  i++
  let out = ''
  while (i < json.length) {
    const ch = json[i]
    if (ch === '\\') {
      // Экранированная последовательность может оборваться на середине — тогда
      // просто дочитали до конца того, что пришло.
      const next = json[i + 1]
      if (next === undefined) break
      out += unescape(next, json.slice(i + 2, i + 6))
      i += next === 'u' ? 6 : 2
      continue
    }
    if (ch === '"') break
    out += ch
    i++
  }
  return tidy(out)
}

/**
 * Где ключ стоит именно КЛЮЧОМ.
 *
 * `{"command": "grep \"file_path\" ."` содержит `"file_path"` внутри значения.
 * Взяв первое вхождение, превью показало бы кусок чужой строки как путь к файлу.
 * Ключ обязан стоять в начале объекта или после запятой.
 */
function keyIndex(json: string, key: string): number {
  const needle = `"${key}"`
  let from = 0
  for (;;) {
    const at = json.indexOf(needle, from)
    if (at < 0) return -1
    let j = at - 1
    while (j >= 0 && /\s/.test(json[j])) j--
    if (j < 0 || json[j] === '{' || json[j] === ',') return at
    from = at + needle.length
  }
}

function unescape(code: string, hex: string): string {
  switch (code) {
    case 'n':
    case 'r':
      return ' '
    case 't':
      return ' '
    case 'b':
    case 'f':
      return ''
    case 'u': {
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return ''
      const ch = String.fromCharCode(parseInt(hex, 16))
      // Управляющий символ в однострочном превью — мусор, а не содержание.
      return ch < ' ' ? ' ' : ch
    }
    default:
      // \" \\ \/ и всё прочее — сам знак.
      return code
  }
}

/** Однострочно и коротко: это строка на один взгляд. */
function tidy(v: string): string {
  const one = v.replace(/\s+/g, ' ').trimStart()
  return one.length > MAX ? `${one.slice(0, MAX)}…` : one
}
