import { t } from '@/lib/i18n'
import type { Conversation, PendingTool } from './aiStore'

/**
 * Which pending approval gates need a card of their own.
 *
 * SECURITY: the approval card is the whole point of the gate — it is what the
 * user reads before saying yes. Claude Code announces a tool as a `tool_use`
 * block, so its card is rendered inline with the transcript. Codex and the ACP
 * engines (Gemini/Kimi/Qwen) only raise a bare `permission` event, so their
 * gates had NO card anywhere — while the keyboard shortcut still approved the
 * pending tool. That is a blind "yes" to a command the user never saw.
 *
 * Anything not described by a `tool_use` block is returned here so the surface
 * can render it. Settled gates are excluded: they are already executing and
 * their card would duplicate the running tool.
 */
export function orphanGates(conv: Conversation): PendingTool[] {
  const described = new Set<string>()
  for (const m of conv.messages) {
    for (const p of m.content) {
      if (p.type === 'tool_use') described.add(p.id)
    }
  }
  // Одобренный гейт остаётся карточкой, пока не придёт результат. Раньше он
  // отсеивался по `settled`, и у движков без `tool_use` (Codex, Gemini, Kimi,
  // Qwen) экран после «ВЫПОЛНИТЬ» становился пустым: команда шла минуту, а
  // лента молчала, будто ничего не запускалось.
  return conv.pendingTools.filter((t) => !described.has(t.id))
}

/**
 * The gate the keyboard acts on: Enter approves / Esc denies the FIRST unsettled
 * non-question gate. Exported so the bar, the card and the feed's scroll anchor
 * agree on which one that is — each used to re-derive it, and they diverged: the
 * feed scrolled to the bottom of the transcript while Enter approved the gate at
 * the top, and every waiting card advertised «Enter · Esc» as if it were the one.
 */
export function nextGate(conv: Conversation): PendingTool | undefined {
  return conv.pendingTools.find((t) => !t.settled && t.kind !== 'question')
}

/**
 * Human label for a tool call, whichever engine raised it. Prefers the concrete
 * thing being done (command / path) over the tool's internal name, and never
 * returns an empty string — an unlabelled gate would be as blind as no gate.
 *
 * Deliberately the single source of truth: the mission feed, the side panel and
 * the orphan-gate path each synthesized their own label, and the side panel's
 * had no path fallback at all — an Edit/Write gate rendered as «—», i.e. the
 * user was asked to approve a file write with nothing on screen describing it.
 */
export function toolLabel(
  name: string,
  input: unknown,
  title?: string,
  displayName?: string
): string {
  const o = (input ?? null) as Record<string, unknown> | null
  const str = (k: string): string => {
    const v = o?.[k]
    return typeof v === 'string' && v.trim() ? v.trim() : ''
  }

  // Скилл называет себя в `input.skill`, и больше нигде: без этой ветки карточка
  // выводила голое «Skill» — то есть агент брал скилл, а человек не видел какой.
  // Аргумент дописываем, если он есть: у скилла это его задание.
  const skill = str('skill')
  if (skill) {
    const args = str('args')
    return `${t('gates.skill')} ${skill}${args ? ` · ${args}` : ''}`
  }
  const command = str('command')
  if (command) return command

  // Выход из режима плана. Единственный вызов, у которого во входе НЕТ ничего:
  // движок держит план в своём файле, а сюда шлёт пустой объект. Без этой ветки
  // карточка выводила голое «ExitPlanMode» — то есть спрашивала согласие на
  // непонятное, а согласие тут крупное: после него агент начинает работать.
  if (name === 'ExitPlanMode') return t('feed.exitPlan')

  /*
   * ПРЕДМЕТ ВЫЗОВА, а не имя инструмента.
   *
   * Раньше здесь знали пять полей, и всё остальное выпадало в голое «WebSearch»,
   * «Glob», «ToolSearch», «SendUserFile». На машине владельца это каждый второй
   * ход: 6 254 вызова поиска в вебе, 6 018 поисков по файлам. Карточка занимала
   * строку и не говорила ничего.
   *
   * Порядок веток имеет значение. `pattern` идёт ПЕРЕД `path`, потому что у
   * Grep есть оба, и раньше побеждал путь: карточка показывала папку и теряла
   * сам шаблон — искали-то не папку.
   */
  const query = str('query')
  if (query) return query
  const url = str('url')
  if (url) return url
  const pattern = str('pattern')
  if (pattern) {
    const where = str('path') || str('glob')
    return where ? `${pattern} · ${where}` : pattern
  }
  // Задача из плана агента (TaskCreate). Панель плана показывает список целиком,
  // но подпись нужна и здесь: карточка живёт в ленте своей жизнью.
  const subject = str('subject')
  if (subject) return subject
  // Поручение субагенту: что именно поручили, а не «Agent».
  const description = str('description')
  if (description) {
    const kind = str('subagent_type')
    return kind ? `${description} · ${kind}` : description
  }
  // Файлы, которые агент отдаёт человеку.
  const files = Array.isArray(o?.files) ? (o.files as unknown[]).filter((f) => typeof f === 'string') : []
  if (files.length) {
    const first = shortName(files[0] as string)
    return files.length > 1 ? `${first} +${files.length - 1}` : first
  }
  // За чем следит Monitor — цель, а не слово «Monitor».
  const target = str('target')
  if (target) return target

  const path = str('file_path') || str('path')
  if (path) return `${name || t('gates.tool')} · ${path}`
  // ACP (Gemini/Kimi/Qwen) carries the human description in `input.title` and in
  // `displayName`, never in a top-level `title` — without this the label decayed
  // to the bare tool name («Bash», «Edit») and the card described nothing.
  const inputTitle = str('title')
  if (inputTitle) return inputTitle
  return title?.trim() || displayName?.trim() || name || t('gates.request')
}

/** Имя файла без пути: в карточке важно ЧТО отдали, а не откуда. */
function shortName(p: string): string {
  // Оба разделителя: пути приходят и в виде `C:\Users\…`, и в виде `/home/…`.
  const leaf = p.split(/[\\/]/).pop()
  return leaf || p
}

/** Label for a gate that has no `tool_use` block to describe it. */
export function gateLabel(t: PendingTool): string {
  return toolLabel(t.name, t.input, t.title, t.displayName)
}

/** Header width, in characters, before the first line is cut with an ellipsis. */
export const GATE_HEAD_CHARS = 88

/** How much of a command a card is showing, and how much it MUST show. */
export interface GateView {
  /** Doesn't fit the single header line — multi-line, or simply long. */
  isLong: boolean
  /** First line, cut to the header width (what the collapsed header shows). */
  label: string
  /** First line, uncut. */
  firstLine: string
  /** Total number of lines. */
  lines: number
  /**
   * The full text must be on screen, in a block of its own, and must not be
   * collapsible. True while ANY non-empty command awaits a decision — not just a
   * "long" one: the header line is a single flex row that shares its width with
   * the tool note, so it ellipsises at roughly half {@link GATE_HEAD_CHARS} and
   * far less in a narrow window. Deciding by character count alone left a band of
   * commands cut by CSS with no fold to open and no tooltip to reveal them.
   */
  mustShowFull: boolean
}

/**
 * SECURITY: an approval card exists to be read before the user says yes, so a
 * command awaiting a decision may not hide any of itself. Cards used to collapse
 * every long or multi-line command to its first 88 characters — the dangerous
 * half of `cd /tmp && rm -rf …` sat behind a fold while «ВЫПОЛНИТЬ» (and Enter)
 * were one keystroke away. Once settled the card may fold again: by then it is
 * history, not a decision.
 */
export function gateView(cmd: string, awaitingDecision: boolean): GateView {
  // A trailing newline is not a second line of the command.
  const parts = cmd.replace(/\n+$/, '').split('\n')
  const firstLine = parts[0] ?? ''
  const multiline = parts.length > 1
  const isLong = multiline || cmd.length > GATE_HEAD_CHARS
  const cut = firstLine.length > GATE_HEAD_CHARS
  const head = cut ? firstLine.slice(0, GATE_HEAD_CHARS) + '…' : firstLine
  return {
    isLong,
    firstLine,
    // `head` already ends in an ellipsis when it was cut — don't add a second one.
    label: isLong ? (multiline ? head + ' ⋯' : head) : cmd,
    lines: parts.length,
    mustShowFull: awaitingDecision && cmd.trim() !== ''
  }
}

/**
 * Is the feed's tail busy — i.e. is the «готов · введите запрос» prompt line a lie?
 *
 * The feed used to render that line unconditionally, so it sat directly under
 * «агент отвечает…»: the same screen claimed the agent was working AND waiting
 * for input. The line means «your turn», so it may only appear when the turn is
 * actually the user's: no stream, no tool in flight (settled ones are still
 * executing until their result lands), no gate awaiting a decision, and no shell
 * command running in the terminal below.
 */
export function feedIsBusy(conv: Conversation | undefined, shellRunning = false): boolean {
  if (shellRunning) return true
  if (!conv) return false
  return conv.streaming || conv.pendingTools.length > 0 || !!conv.queued
}
