/**
 * Команды агента: то, что человек набирает через «/».
 *
 * У Claude Code их больше сотни из пяти источников разом — встроенные, скиллы,
 * плагины, свои из `.claude/commands`, MCP-промпты, — и SDK отдаёт их одним
 * плоским списком, в котором есть дубли и служебные записи. Разбирать это в
 * интерфейсе нельзя: список должен приходить туда уже пригодным для показа.
 *
 * Модуль общий для главного процесса и окна: главный чистит то, что пришло от
 * движка, окно теми же правилами ищет по набранному.
 */

export interface AgentCommand {
  /** Имя БЕЗ ведущего слэша — так его отдаёт SDK, так и храним. */
  name: string
  description: string
  /** Подсказка аргументов, например `<file>`. Пусто — аргументов нет. */
  argumentHint?: string
  aliases?: string[]
}

export interface AgentCommandList {
  commands: AgentCommand[]
  /**
   * Откуда список. Показывается человеку в шапке: «список от движка» и «мы не
   * знаем, что умеет этот движок» — разные вещи, и путать их нельзя.
   */
  source: 'engine' | 'unknown'
  /** Движок команд не назвал — честная причина для пустого списка. */
  note?: string
}

/** Служебное, чему нечего делать в списке для человека. */
const HIDDEN = /^(__|workflow-launch-exec$|heapdump$)/

/**
 * Привести список от движка к тому, что не стыдно показать.
 *
 * Три вещи, каждая из-за реального мусора в ответе SDK:
 * 1. Ведущий слэш не согласован между источниками — снимаем везде.
 * 2. Дубли: `review`, `gstack`, `browse` приходят по два-три раза (один и тот
 *    же скилл виден и как команда проекта, и как плагин). Оставляем первый.
 * 3. Служебные записи (`__remote-workflow`, `heapdump`) — не команды человека.
 */
export function cleanCommands(raw: unknown): AgentCommand[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AgentCommand[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = String(o.name ?? '').replace(/^\/+/, '').trim()
    if (!name || HIDDEN.test(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      description: typeof o.description === 'string' ? o.description.trim() : '',
      argumentHint:
        typeof o.argumentHint === 'string' && o.argumentHint.trim()
          ? o.argumentHint.trim()
          : undefined,
      aliases: Array.isArray(o.aliases)
        ? o.aliases.filter((a): a is string => typeof a === 'string')
        : undefined
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Открывается ли список команд для этого текста и позиции каретки.
 *
 * «/» считается вызовом ТОЛЬКО первым непробельным символом. Внутри слова, в
 * пути `src/main/ipc.ts`, в URL или в регулярке — никогда: это главная жалоба
 * на чужие реализации, где список выскакивает посреди набора пути и съедает
 * следующее нажатие.
 */
export function commandQuery(text: string, caret: number): string | null {
  const upto = text.slice(0, caret)
  // Начало строки или начало новой строки после переноса — и ничего, кроме
  // пробелов, перед слэшем.
  const line = upto.slice(upto.lastIndexOf('\n') + 1)
  const m = /^\s*\/([^\s/]*)$/.exec(line)
  return m ? m[1] : null
}

/**
 * Найти команды по набранному.
 *
 * Точное совпадение имени — ВСЕГДА первое. В самом Claude Code это открытый
 * баг: набрав `/review`, человек получает `review-pr` первой строкой и Enter
 * запускает не то. Дальше по убыванию точности: начало имени, вхождение в имя,
 * совпадение в псевдониме, слово из описания.
 */
export function matchCommands(list: AgentCommand[], query: string): AgentCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  const rank = (c: AgentCommand): number => {
    const name = c.name.toLowerCase()
    if (name === q) return 0
    if (name.startsWith(q)) return 1
    if ((c.aliases ?? []).some((a) => a.toLowerCase() === q)) return 2
    if (name.includes(q)) return 3
    if ((c.aliases ?? []).some((a) => a.toLowerCase().includes(q))) return 4
    if (c.description.toLowerCase().includes(q)) return 5
    return 99
  }
  return list
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r < 99)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c)
}

/**
 * Что подставить в строку вместо набранного «/фрагмент».
 *
 * Пробел в конце ставится только когда у команды есть аргументы: иначе человеку
 * пришлось бы стирать его перед отправкой, а лишнее нажатие в самом частом
 * жесте — это плохая сделка.
 */
export function applyCommand(text: string, caret: number, cmd: AgentCommand): {
  text: string
  caret: number
} {
  const upto = text.slice(0, caret)
  const lineStart = upto.lastIndexOf('\n') + 1
  const before = text.slice(0, lineStart)
  const rest = text.slice(caret)
  const indent = /^\s*/.exec(upto.slice(lineStart))?.[0] ?? ''
  const inserted = `${indent}/${cmd.name}${cmd.argumentHint ? ' ' : ''}`
  return { text: before + inserted + rest, caret: before.length + inserted.length }
}
