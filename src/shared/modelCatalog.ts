/**
 * Каталог моделей провайдера.
 *
 * Список моделей был захардкожен в коде и устаревал молча: вышел Opus 5 — а в
 * пусковом комплексе по-прежнему Opus 4.8, и человек выбирал из вчерашнего.
 * Теперь список приходит от самого провайдера, а здесь живёт то, что не зависит
 * ни от сети, ни от процесса: разбор ответа и сравнение каталогов.
 */

/** Сколько моделей держим на провайдера. Дальше это уже не выбор, а свалка. */
export const MODELS_MAX = 60

/** Что известно про каталог одного провайдера. */
export interface ProviderCatalog {
  /** Идентификаторы моделей, свежие сверху. */
  ids: string[]
  /** Когда список получен. `0` — не получали ни разу. */
  at: number
  /** Список из кода, а не от провайдера: показываем, но честно помечаем. */
  fallback?: boolean
}

/**
 * Разобрать ответ провайдера в список моделей.
 *
 * Форматы разные, но все три сводятся к списку записей с идентификатором:
 * Anthropic и OpenAI отдают `{data: [{id}]}`, Ollama — `{models: [{name}]}`.
 * Чужой ответ разбираем осторожно: это данные из сети, и «просто взять
 * `json.data.map`» на неожиданной форме уронило бы главный процесс.
 */
export function parseModelList(json: unknown): string[] {
  const root = json as { data?: unknown; models?: unknown }
  const rows = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : []
  const out: string[] = []
  for (const row of rows) {
    const r = row as { id?: unknown; name?: unknown }
    const id = typeof r?.id === 'string' ? r.id : typeof r?.name === 'string' ? r.name : ''
    const clean = id.trim()
    if (clean && !out.includes(clean)) out.push(clean)
    if (out.length >= MODELS_MAX) break
  }
  return out
}

/**
 * Что в каталоге появилось нового по сравнению с уже виденным.
 *
 * Сравниваем с ВИДЕННЫМ, а не с прошлым ответом: иначе отвалившаяся сеть
 * покажет «новинку» второй раз, а это ровно то доверие, которое теряется с
 * первого ложного окна.
 */
export function freshModels(seen: string[], fresh: string[]): string[] {
  const known = new Set(seen)
  return fresh.filter((id) => !known.has(id))
}

/**
 * Пополнить список виденного.
 *
 * Потолок общий с каталогом: список виденного нужен только чтобы не показать
 * окно дважды, и хранить в нём всю историю моделей провайдера незачем.
 */
export function withSeen(seen: string[], fresh: string[], max = MODELS_MAX * 2): string[] {
  const out = [...seen]
  for (const id of fresh) if (!out.includes(id)) out.push(id)
  if (out.length <= max) return out
  // Обрезка идёт по САМЫМ СТАРЫМ, но всё, что провайдер отдаёт сейчас, из неё
  // исключено. Иначе у провайдера с сотней идентификаторов список виденного
  // упирался в потолок, оттуда вылетали давно знакомые модели — и Заря
  // объявляла их новинкой во второй раз. Окно «появилась новая модель» стоит
  // ровно на том, что оно не повторяется.
  const live = new Set(fresh)
  const keep = out.filter((id) => live.has(id))
  const rest = out.filter((id) => !live.has(id))
  const room = Math.max(0, max - keep.length)
  const trimmedRest = room ? rest.slice(-room) : []
  // Порядок исходного списка сохраняется: он и есть история знакомства.
  const survive = new Set([...keep, ...trimmedRest])
  return out.filter((id) => survive.has(id))
}

/**
 * Человеческое имя модели по её идентификатору: «claude-opus-5» → «Opus 5».
 *
 * Провайдеры отдают идентификаторы, а не названия. Показывать их как есть можно
 * (и в списке мы так и делаем), но в окне «появилась новая модель» строка
 * читается человеком, а не парсером.
 */
export function prettyModelName(id: string): string {
  return id
    .replace(/^(claude|gpt|models)[-/]/i, (m) => (m.toLowerCase().startsWith('gpt') ? m : ''))
    .replace(/-(\d{6,})$/, '')
    .replace(/\[1m\]$/i, ' 1M')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
