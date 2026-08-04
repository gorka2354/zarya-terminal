import type { McpServerRow } from './types'
import { effectiveState } from './skills'

/**
 * Стрижка ответа SDK до того, что можно показать человеку.
 *
 * Главная мысль файла: **секреты не должны пересекать IPC**. У SDK в
 * `McpServerStatus.config` лежат `env` (переменные окружения локального
 * сервера) и `headers` (заголовки сетевого) — то есть ровно ключи и токены.
 * Если отдать статус в рендерер целиком и «просто не рисовать» эти поля, они
 * всё равно окажутся в другом процессе, в DevTools и в дампе. Поэтому главный
 * процесс собирает узкую строку сам, а всё остальное выбрасывает здесь.
 *
 * Вторая мысль: **не додумывать за движок**. Состояние берётся как названо,
 * причина отказа — дословно. Своих формулировок вроде «наверное, упал» тут нет.
 */

/** Кусок ответа SDK, который нас интересует. Типизирован структурно: версия SDK
 *  может добавить поля, и падать из-за этого нельзя. */
export interface RawMcpStatus {
  name?: unknown
  status?: unknown
  error?: unknown
  scope?: unknown
  serverInfo?: { name?: unknown; version?: unknown }
  config?: Record<string, unknown>
  /** Инструменты сервера: считаем их и читаем пометки, больше ничего. */
  tools?: { name?: unknown; annotations?: McpMark }[]
}

/** Инструмент из `getContextUsage()`: во сколько токенов он обходится. */
export interface RawMcpTool {
  name?: unknown
  serverName?: unknown
  tokens?: unknown
}

const KNOWN_STATUS = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'] as const
type KnownStatus = (typeof KNOWN_STATUS)[number]

function asStatus(v: unknown): KnownStatus {
  return (KNOWN_STATUS as readonly string[]).includes(v as string)
    ? (v as KnownStatus)
    : // Незнакомое состояние из будущей версии SDK честнее показать как
      // «ждёт», чем как «работает»: обещать работоспособность мы не вправе.
      'pending'
}

function asText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s : undefined
}

/**
 * Хост из URL — и ТОЛЬКО хост.
 *
 * Путь и query остаются за бортом намеренно: у самодельных серверов ключ часто
 * зашит прямо в адрес (`…/mcp-server/http?token=…`, вебхуки n8n). Показать
 * «откуда сервер» можно и одним хостом, а показать секрет — нельзя.
 */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

/**
 * Имя команды без пути и без аргументов.
 *
 * Аргументы не показываем вообще: там встречается и `--token=…`, и путь к
 * домашней папке. Отличать «секретный аргумент» от обычного пришлось бы
 * эвристикой, а эвристика в вопросе секретов — это способ однажды ошибиться.
 */
export function commandOf(command: string): string | undefined {
  const cleaned = command.trim().replace(/["']/g, '')
  if (!cleaned) return undefined
  const last = cleaned.split(/[\\/]/).pop()
  return last || undefined
}

/** Как сервер подключён и откуда он — по конфигу, без единого значения из него. */
function originOf(config: Record<string, unknown> | undefined): {
  transport?: string
  origin?: string
} {
  if (!config) return {}
  const type = asText(config.type)
  const url = asText(config.url)
  const command = asText(config.command)
  if (url) return { transport: type || 'http', origin: hostOf(url) }
  if (command) return { transport: type || 'stdio', origin: commandOf(command) }
  // Сервер, живущий внутри самого SDK: адреса у него нет и быть не может.
  return { transport: type || undefined }
}

/** Одна строка для окна: имя, состояние, причина, происхождение — и ничего больше. */
export function mcpRowFrom(raw: RawMcpStatus, tokens?: number): McpServerRow {
  const { transport, origin } = originOf(raw.config)
  const row: McpServerRow = {
    name: asText(raw.name) ?? '?',
    status: asStatus(raw.status)
  }
  const error = asText(raw.error)
  if (error) row.error = error
  if (transport) row.transport = transport
  if (origin) row.origin = origin
  const scope = asText(raw.scope)
  if (scope) row.scope = scope
  const version = asText(raw.serverInfo?.version)
  if (version) row.version = version
  if (Array.isArray(raw.tools)) row.tools = raw.tools.length
  if (typeof tokens === 'number' && tokens > 0) row.tokens = tokens
  return row
}

/**
 * Сколько токенов стоят инструменты КАЖДОГО сервера.
 *
 * Складываем по имени сервера, потому что человек выключает сервер целиком, а
 * не отдельный инструмент: цена решения — это сумма его инструментов. Числа
 * считает движок, мы только группируем; своей арифметики поверх не изобретаем,
 * иначе итог разойдётся с `/context` и веры не будет ни одной из двух цифр.
 */
export function foldMcpTokens(tools: RawMcpTool[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Array.isArray(tools)) return out
  for (const t of tools) {
    const server = asText(t?.serverName)
    const tokens = typeof t?.tokens === 'number' && t.tokens > 0 ? t.tokens : 0
    if (!server || !tokens) continue
    out[server] = (out[server] ?? 0) + tokens
  }
  return out
}

/**
 * Чем сервер пометил свой инструмент.
 *
 * Это ЕГО заявление, а не наша проверка: MCP разрешает серверу объявить
 * инструмент разрушающим, только читающим или ходящим наружу. Заря такие
 * пометки показывает и называет источник — «сервер помечает», — потому что
 * поручиться за них не может: сервер вправе не заполнить их вовсе или ошибиться.
 * Отсутствие пометки поэтому НЕ значит «безопасно», и интерфейс не должен
 * подсказывать обратное.
 */
export interface McpMark {
  destructive?: boolean
  readOnly?: boolean
  openWorld?: boolean
}

/**
 * Полное имя инструмента так, как его назовёт движок в запросе разрешения:
 * `mcp__<сервер>__<инструмент>`, где в имени сервера всё за пределами
 * `A-Z a-z 0-9 _ -` заменено на `_` (правило самого Claude Code — так
 * `claude.ai Notion` становится `claude_ai_Notion`).
 */
export function mcpToolFullName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`
}

/** Разложить инструменты серверов в карту «полное имя → пометки сервера». */
export function markIndex(
  servers: { name?: unknown; tools?: { name?: unknown; annotations?: McpMark }[] }[]
): Record<string, McpMark> {
  const out: Record<string, McpMark> = {}
  for (const s of servers ?? []) {
    const server = typeof s?.name === 'string' ? s.name : ''
    if (!server || !Array.isArray(s.tools)) continue
    for (const tool of s.tools) {
      const name = typeof tool?.name === 'string' ? tool.name : ''
      const a = tool?.annotations
      if (!name || !a) continue
      // Пустую пометку не храним: «сервер ничего не сказал» и «сервер сказал
      // нет» — разные вещи, и первая не должна выглядеть как вторая.
      const mark: McpMark = {}
      if (a.destructive === true) mark.destructive = true
      if (a.readOnly === true) mark.readOnly = true
      if (a.openWorld === true) mark.openWorld = true
      if (Object.keys(mark).length) out[mcpToolFullName(server, name)] = mark
    }
  }
  return out
}

/**
 * Скиллы из ответа движка — в вид, пригодный для показа.
 *
 * Здесь же чистка от мусора: незаполненное имя, отрицательные токены, вообще
 * отсутствующий список. Скилл без имени показывать нечем, а «0 токенов» у
 * скилла означает не «бесплатно», а «движок не сказал».
 */
export function skillsFrom(
  raw:
    | {
        totalSkills?: unknown
        includedSkills?: unknown
        tokens?: unknown
        skillFrontmatter?: { name?: unknown; source?: unknown; tokens?: unknown }[]
      }
    | undefined,
  /** Слои `skillOverrides` — чем скилл выключен и кем, если выключен. */
  layers?: Partial<Record<import('./types').SkillLayer, Record<string, unknown> | undefined>>
): import('./types').McpSkills | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
  const items = (Array.isArray(raw.skillFrontmatter) ? raw.skillFrontmatter : [])
    .map((s) => {
      const name = typeof s?.name === 'string' ? s.name.trim() : ''
      return {
        name,
        source: typeof s?.source === 'string' ? s.source.trim() : '',
        tokens: num(s?.tokens),
        ...effectiveState(name, layers ?? {})
      }
    })
    .filter((s) => s.name)
  // Выключенные скиллы движок не присылает вовсе: он отдаёт то, что ВОШЛО в
  // контекст. Без этого шага дверь открывалась бы в одну сторону — выключить
  // можно, а найти и вернуть уже нечем. Достаём их из самих настроек; цены у
  // них нет, потому что в контексте их нет.
  const known = new Set(items.map((s) => s.name))
  for (const layer of ['user', 'project', 'local'] as import('./types').SkillLayer[]) {
    for (const name of Object.keys(layers?.[layer] ?? {})) {
      if (known.has(name)) continue
      const st = effectiveState(name, layers ?? {})
      if (st.state === 'on') continue
      known.add(name)
      items.push({ name, source: '', tokens: 0, ...st })
    }
  }
  items.sort(
    (a, b) =>
      // Выключенные — вниз: это уже решённое, а разговор здесь про то, за что
      // платится сейчас.
      Number(a.state === 'off') - Number(b.state === 'off') ||
      b.tokens - a.tokens ||
      a.name.localeCompare(b.name, 'en')
  )
  const total = num(raw.totalSkills) || items.length
  if (!total && !items.length) return undefined
  return {
    total,
    included: num(raw.includedSkills) || items.length,
    tokens: num(raw.tokens),
    items
  }
}

/**
 * Команда, которой человек войдёт в сервер руками.
 *
 * Логинить из Зари мы пока не умеем, поэтому даём точный путь — и он обязан
 * РАБОТАТЬ при простом копировании. Имена вроде `claude.ai Notion` содержат
 * пробел: без кавычек CLI прочитает их как два аргумента, команда упадёт, и
 * подсказка окажется той самой кнопкой, которая соврала.
 */
export function mcpLoginCommand(name: string): string | null {
  if (!shellSafeName(name)) return null
  // Пробел — единственный символ, ради которого нужны кавычки: он частый и
  // безобидный («claude.ai Notion»). Всё остальное отсеяно проверкой выше.
  return `claude mcp login ${name.includes(' ') ? `"${name}"` : name}`
}

/**
 * Имя, которое можно поставить в командную строку, не гадая про оболочку.
 *
 * Раньше «опасное» имя заворачивалось в двойные кавычки с экранированием по
 * правилам sh — а копируют команду в PowerShell, где обратный слэш не
 * экранирует НИЧЕГО: `\"` там просто закрывает строку, и хвост исполняется как
 * отдельная команда. Имя сервера приходит из `.mcp.json` открытого проекта, то
 * есть это ЧУЖОЙ текст: получалось выполнение произвольного кода из файла в
 * чужом репозитории — по кнопке, которая обещала «честный ручной путь».
 *
 * Экранирования, безопасного сразу для sh, PowerShell и cmd, не существует.
 * Поэтому готовую строку показываем ТОЛЬКО для имён без единого метасимвола:
 * буквы, цифры, `. _ : -` и пробел. Для остальных интерфейс честно говорит, что
 * команды не будет, и даёт скопировать само имя.
 */
export function shellSafeName(name: string): boolean {
  return /^[A-Za-z0-9._:\- ]+$/.test(name) && name.trim() === name && name.length <= 120
}

/**
 * Ждущие внимания — вперёд.
 *
 * Порядок здесь — это очередь к человеку, как в сайдбаре с панелями: сломанное
 * и требующее логина сверху, работающее ниже, выключенное в конце. Внутри
 * группы — по имени, чтобы список не прыгал между обновлениями.
 */
const STATUS_ORDER: Record<McpServerRow['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  pending: 2,
  connected: 3,
  disabled: 4
}

export function sortMcpRows(rows: McpServerRow[]): McpServerRow[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, 'en')
  )
}
