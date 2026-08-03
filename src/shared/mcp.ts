import type { McpServerRow } from './types'

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
  tools?: unknown[]
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
 * Команда, которой человек войдёт в сервер руками.
 *
 * Логинить из Зари мы пока не умеем, поэтому даём точный путь — и он обязан
 * РАБОТАТЬ при простом копировании. Имена вроде `claude.ai Notion` содержат
 * пробел: без кавычек CLI прочитает их как два аргумента, команда упадёт, и
 * подсказка окажется той самой кнопкой, которая соврала.
 */
export function mcpLoginCommand(name: string): string {
  const safe = /^[A-Za-z0-9._:-]+$/.test(name)
  return `claude mcp login ${safe ? name : `"${name.replace(/(["\\$`])/g, '\\$1')}"`}`
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
