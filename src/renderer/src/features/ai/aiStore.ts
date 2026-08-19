import { create } from 'zustand'
import type {
  AgentEngine,
  AgentStreamEvent,
  AiChatRequest,
  AiContentPart,
  AiMessage,
  AiStreamEvent,
  AiToolDef,
  BlockBrief,
  BlockRecord,
  ClaudeCliQuestion
} from '@shared/types'
import type { AiConversationsState } from '@shared/types'
import { imagePlaceholder, type ImageAttachment } from '@shared/images'
import { attachTurnId } from '@shared/turnId'
import { EFFORT_TUNING } from '@shared/defaults'
import { onBus } from '@/lib/bus'
import { t } from '@/lib/i18n'
import { onQuitFlush } from '@/lib/quitFlush'
import { uid } from '@/lib/uid'
import { useBlocksStore } from '@/state/blocksStore'
import { getSettings, useSettingsStore } from '@/state/settingsStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { setAgentStatusFor, useUiStore } from '@/state/uiStore'
import { addCost } from '@shared/cost'
import { registerAiBridge } from './aiBridge'
import { gateLabel } from './gates'
import { applySubagentEvent, type SubagentRun } from './subagents'
import type { BackgroundTask } from '@shared/agentTasks'
import { enginePromptAppend } from '@shared/enginePrompt'
import { shellTail, type ShellTail } from '@shared/shellTail'
import { clampText, overSpend, rememberSpend, spentInHour, type Spend } from '@shared/paneMessage'
import { sameModel } from './modelMatch'
import { nativeGateOpts } from './startOpts'
import { irreversible } from '@shared/irreversible'
import { EMPTY_PLAN, planOnToolResult, planOnToolUse } from '@shared/agentPlan'
import { matchesRule, ruleFor, withRule } from '@shared/allowRules'
import { notePulse, type ToolPulse } from '@shared/toolPulse'
import { fitToolImages, type ToolImage } from '@shared/images'

/**
 * AI chat store: multiple conversations, streaming assistant text, and an
 * agentic tool loop (run_command) with manual or automatic approval.
 */

// ---------------------------------------------------------------- constants

/** Wait window for a command's output before giving up on the tool call. */
const TOOL_TIMEOUT_MS = 45_000
/** Cap on tool_result output sent back to the model. */
const TOOL_OUTPUT_CAP = 4000
/** Cap on per-block output attached as automatic system-prompt context. */
const CONTEXT_BLOCK_OUTPUT_CAP = 1500
/**
 * Поиск по своей консоли: сколько блоков и сколько знаков на совпадение.
 *
 * Отрывок приезжает агенту БЕЗ отдельного решения человека про конкретный блок
 * — карточку он одобрил на поиск, а не на чтение каждого найденного. Отсюда
 * пределы: это ответ «смотри туда», а не способ вычитать журнал по кусочкам.
 */
const SEARCH_HITS = 5
const SNIPPET_CAP = 200

/**
 * ЧТО НАРАБОТАЛА ПЕРЕПИСКА ПАНЕЛЕЙ — по парам, за последний час.
 *
 * Ключ — «кто написал → кому», потому что предохранитель именно про пару: своя
 * работа человека сюда не попадает вовсе, считаются только ходы, начатые ЧУЖОЙ
 * запиской. Это единственное место в Заре, где платный ход стартует без единого
 * нажатия.
 *
 * ЖИВЁТ В ОКНЕ, а не в главном процессе, потому что деньги знает окно: цифру
 * хода приносит движок в конце, и здесь же она копится по беседе. Отдавать её
 * в главный процесс ради проверки значило бы завести вторую копию, которая
 * однажды разойдётся с первой.
 *
 * НЕ ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК намеренно: окно предохранителя — час, а перезапуск
 * Зари — это уже человек за клавиатурой.
 */
const notePairSpend = new Map<string, Spend[]>()
const pairKey = (from: string, to: string): string => `${from} -> ${to}`

/**
 * Сколько живёт пометка «сказала, что ждёт ответа».
 *
 * Десять минут — это заметно больше, чем идёт ход соседа, и заметно меньше,
 * чем человек готов смотреть на лампочку, которая уже ничего не значит.
 * Ожидание объявила модель; забыть о нём она может молча, и пометка,
 * пережившая свой смысл, врёт ровно как любой другой протухший индикатор.
 */
const AWAIT_TTL_MS = 10 * 60_000

/** Пометка ещё в силе? Проверяется при показе — таймеров ради неё не заводим. */
export function awaitingNow(
  awaiting: { at: number } | undefined,
  now: number
): boolean {
  return !!awaiting && now - awaiting.at < AWAIT_TTL_MS
}

const RUN_COMMAND_TOOL: AiToolDef = {
  name: 'run_command',
  description: t('ai.tool.runDesc'),
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: t('ai.tool.cmdDesc') },
      reason: { type: 'string', description: t('ai.tool.reasonDesc') }
    },
    required: ['command']
  }
}

// -------------------------------------------------------------------- types

export interface AiContextChip {
  id: string
  label: string
  content: string
}

export interface PendingTool {
  id: string
  name: string
  input: unknown
  /** Whether settings.ai.autoApprove decided this without asking the user. */
  autoApproved: boolean
  /** True once a decision has been made (approved/auto) and it's executing — hides the action buttons. */
  settled: boolean
  /**
   * 'run' — a normal approve/deny gate (built-in run_command, or a Claude Code
   * tool permission). 'question' — Claude Code's AskUserQuestion: the input bar
   * morphs into a native choice selector. Undefined ⇒ 'run'.
   */
  kind?: 'run' | 'question'
  /** AskUserQuestion payload when kind === 'question'. */
  questions?: ClaudeCliQuestion[]
  /** Human-readable prompt / short label from the driver (Claude Code). */
  title?: string
  displayName?: string
  /**
   * У этого гейта нет разового разрешения — агент предлагает только «всегда».
   * Кнопка обязана назвать это вслух, иначе одобрение действует до конца сессии,
   * а человек думает, что разрешил один запуск.
   */
  allowAlwaysOnly?: boolean
  /**
   * Гейт показан НЕСМОТРЯ на автопилот: команда необратима. Карточка обязана
   * назвать причину, иначе вопрос при снятом гейте читается как поломка.
   */
  irreversible?: { kind: string; hit: string }
  /**
   * Чем пометил инструмент САМ сервер (MCP-аннотации). Отличать от
   * {@link irreversible}: то — наш список необратимого, это — заявление
   * стороннего сервера, за которое мы не ручаемся. Приходит вместе с гейтом
   * или чуть позже отдельным событием.
   */
  mcpMark?: import('@shared/mcp').McpMark
  /**
   * Когда этот гейт встал и начал ждать человека.
   *
   * Нужен, чтобы сказать «ждёт 4 минуты». Это не украшение: в модели с четырьмя
   * панелями агент, о котором забыли, стоит ровно столько же, сколько агент,
   * который не работает, — и человек должен видеть, во что ему обошлось
   * невнимание.
   */
  askedAt?: number
}

/**
 * Чем занята беседа с точки зрения ЧЕЛОВЕКА.
 *
 * Раньше «работает» и «ждёт твоего Enter» считались одним состоянием
 * (`streaming || pendingTools.length > 0`) и подписывались одним словом. Для
 * одной панели разница невелика; для четырёх это главная ежедневная потеря:
 * чем лучше работает автопилот, тем чаще человек не знает, кто из четверых
 * стоит и ждёт нажатия. Работающий агент не требует ничего, ждущий — требует
 * всего, и путать их нельзя.
 *
 * Считается СТРОГО по фактическим гейтам, без догадок по выводу: индикатор
 * состояния врёт легче всего остального в интерфейсе, а «готов» вместо
 * «завис» — худшая из его неправд.
 */
export type Attention = 'waiting' | 'working' | 'idle'

export function attentionOf(conv: Conversation): Attention {
  if (conv.pendingTools.some((t) => !t.settled)) return 'waiting'
  return conv.streaming ? 'working' : 'idle'
}

/** С какого момента беседа ждёт человека (самый ранний нерешённый гейт). */
export function waitingSince(conv: Conversation): number | null {
  const times = conv.pendingTools.filter((t) => !t.settled).map((t) => t.askedAt ?? 0)
  const first = times.filter(Boolean).sort((a, b) => a - b)[0]
  return first ?? null
}

export interface Conversation {
  id: string
  title: string
  messages: AiMessage[]
  /** Terminal session this conversation is bound to (for tool execution / context). */
  sessionId?: string
  /**
   * 'builtin' — Zarya's own provider agent (Anthropic/OpenAI/Ollama API key).
   * 'claude-code' — the native Claude Code driver (subscription/Max login, its
   * own tools + AskUserQuestion). Chosen at creation, drives send() routing.
   */
  engine: 'builtin' | AgentEngine
  /** Claude Code session id (from init/result) for resume / continuity. */
  claudeSessionId?: string
  /**
   * У живой сессии этой беседы есть копии файлов — значит откат возможен.
   *
   * Приходит с `init` и живёт рядом с id сессии: тумблер настроек мог быть
   * тронут уже после старта, и решать по нему значило бы показать кнопку,
   * за которой ничего нет.
   */
  checkpointing?: boolean
  /**
   * Точка ветки после отмены отправленного сообщения: следующий ход возьмёт
   * историю ДО этого ответа агента. Живёт до init новой сессии.
   */
  resumeAt?: string
  /**
   * Indices of user turns that were interrupted with Esc. They look exactly
   * like ordinary turns otherwise — no answer ever arrives — and the agent
   * still sees them on resume, so the feed says so out loud.
   */
  interrupted?: number[]
  /**
   * ЭТА панель консоль человека агенту не подаёт.
   *
   * Пер-панельно, а не глобально: сколько команд подавать — вопрос настройки
   * на всё приложение, а «сюда не подавай» — решение про КОНКРЕТНЫЙ разговор,
   * и принимается оно ровно там, где человек увидел, что именно уехало.
   *
   * Хранится в беседе и переживает перезапуск: отказ подавать свою консоль —
   * не настроение на один ход, и молча вернуть подачу назавтра было бы
   * ровно тем враньём, ради которого плашка и заведена.
   */
  shellTailOff?: boolean
  /**
   * Этот ход начала записка ВОТ ЭТОЙ панели — и до его конца.
   *
   * Нужна одному: денежному предохранителю. Стоимость движок называет в конце
   * хода, а к тому времени о том, кто его начал, знать уже неоткуда. Без
   * пометки предохранитель считал бы работу человека тоже и гасил бы
   * переписку за то, чего она не тратила.
   *
   * НЕ ХРАНИТСЯ и не переживает перезапуск: это про один идущий ход.
   */
  noteFrom?: string
  /**
   * Эта панель СКАЗАЛА, что ждёт ответа от соседа.
   *
   * ЭТО ЗАЯВЛЕНИЕ АГЕНТА, А НЕ СОСТОЯНИЕ ПРИЛОЖЕНИЯ, и подпись на экране
   * обязана говорить именно так. Никакого ожидания в коде не происходит: ход
   * закончен, гейтов нет, `attentionOf` по-прежнему честно скажет «свободна».
   * Модель может о своём ожидании забыть, передумать или уйти в другой
   * разговор — потому и живёт эта пометка недолго и гаснет сама.
   *
   * Гаснет: от первой же записки в обратную сторону и по времени
   * (`AWAIT_TTL_MS`). Вечная лампочка «ждёт» была бы худшим исходом: человек
   * смотрел бы на неё вместо того, чтобы вмешаться.
   */
  awaiting?: { pane: string; convId: string; at: number }
  /**
   * Куда вернуть беседу, когда боковой вопрос отвечен.
   *
   * Ставится ПЕРЕД отправкой бокового вопроса (позже точку взять неоткуда:
   * «последний ответ» к тому моменту — ответ на сам вопрос) и срабатывает,
   * когда ход кончился.
   *
   * ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК. Сперва я решил обратное — «точка живёт в памяти
   * движка». Ревью возразило фактом: соседняя точка отмены (`resumeAt`)
   * персистится ровно так же и работает, потому что указывает на запись в
   * транскрипте на диске, а не на состояние процесса.
   */
  /**
   * Чем заполнено контекстное окно ЭТОЙ беседы — по счёту самого движка.
   *
   * Своей арифметики здесь нет и быть не может: сколько занято, знает только
   * движок, и он это присылает. Живёт в беседе, а не в общем состоянии окна,
   * потому что у четырёх панелей четыре разных разговора — а общее значение
   * перезаписывал бы кто угодно, и строка показывала бы соседское.
   */
  context?: { pct?: number; tokens?: number; window?: number }
  sideBack?: { sessionId: string; at: string }
  /** Live subagent wave, keyed by task id. Cleared when the turn ends. */
  subagents?: Record<string, SubagentRun>
  /**
   * КТО СЕЙЧАС В ФОНЕ — набор целиком, как его называет движок.
   *
   * Не считаем сами: движок шлёт полный состав при каждом изменении, и
   * заменять его целиком — прямое требование SDK. Своя арифметика по рёбрам
   * «началось / кончилось» однажды потеряет пару, и счётчик «в фоне 1»
   * останется гореть над пустотой.
   *
   * Живёт в памяти и не сохраняется: фоновая задача умирает вместе с процессом
   * движка, и поднимать её из файла значило бы показывать список мертвецов.
   */
  background?: BackgroundTask[]
  /** Working directory the conversation was opened in (folder the AI worked in). */
  cwd?: string
  /**
   * Во сколько обошёлся ЭТОТ разговор, по счёту самого движка.
   *
   * Копится по ходам и переживает перезапуск вместе с беседой. На подписке это
   * расчёт по тарифам API, а не списание — интерфейс обязан это сказать рядом
   * с цифрой (см. `bar.costHintPlan`).
   */
  costUsd?: number
  /**
   * АВТОПИЛОТ этой беседы: агент выполняет инструменты, не спрашивая. Своё у
   * каждой панели — общий переключатель с четырьмя панелями неизбежно врал бы о
   * том, спросят ли вас. Не сохраняется на диск намеренно: перезапуск должен
   * возвращать спрашивание, а не тихо взводить автопилот заново.
   */
  bypass?: boolean
  /**
   * «Правки без спроса» — ступень между вопросом на каждый вызов и автопилотом.
   * Принадлежит БЕСЕДЕ, как и автопилот: панели рядом решают за себя.
   */
  editsAuto?: boolean
  /**
   * Режим плана этой беседы: агент ничего не выполняет, а сперва рассказывает,
   * что собирается сделать.
   *
   * Своё у каждой панели — по той же причине, что и автопилот. И так же не
   * сохраняется на диск: перезапуск должен возвращать обычную работу, а не
   * молча оставлять агента связанным.
   */
  planMode?: boolean
  /**
   * Что человек разрешил в этой беседе до конца сессии.
   *
   * Середина между «спрашивать всё» и «не спрашивать ничего»: за день человек
   * сто раз подтверждает `git status` и к пятидесятому перестаёт читать
   * карточку — гейт вроде есть, а решения уже нет. Правило создаёт он сам и
   * видит дословно; необратимое сюда не попадает никогда (см. allowRules).
   *
   * На диск не сохраняется намеренно, как и автопилот: перезапуск возвращает
   * спрашивание, а не тихо восстанавливает вчерашние разрешения.
   */
  sessionAllows?: string[]
  /**
   * Папки СВЕРХ рабочей, куда человек пустил агента в этой беседе.
   *
   * Такое же разрешение, как и правило выше, и живёт по тем же правилам: выдаёт
   * его человек, видит дословно, на диск оно не сохраняется. Перезапуск
   * возвращает агента в одну папку — молча восстановить вчерашний доступ к
   * чужому каталогу было бы худшим видом удобства.
   */
  extraDirs?: string[]
  /**
   * Состав папок в списке разошёлся с тем, что знает живая сессия движка.
   *
   * Бывает от одного: папку отозвали ПОСРЕДИ хода. Оборвать работу ради этого
   * нельзя, а оставить как есть — значит показывать отозванным доступ, который
   * действует. Поэтому помечаем и применяем на первом же покое.
   */
  dirsDirty?: boolean
  /**
   * Какие скиллы агент РЕАЛЬНО взял в этой беседе.
   *
   * Платится за все: описание каждого скилла лежит в контексте любого запроса,
   * а срабатывают единицы. Без этого списка «83 скилла, 5 347 токенов» — просто
   * число, и решить по нему нечего. С ним видно, за что деньги уходят впустую,
   * а какой скилл трогать нельзя, потому что он работает.
   *
   * На диск не сохраняется: это наблюдение за живой беседой, и после
   * перезапуска честнее пустой список, чем вчерашний, выданный за сегодняшний.
   */
  skillsUsed?: string[]
  /**
   * План агента: чек-лист, который он ведёт себе сам (TaskCreate/TaskUpdate).
   *
   * Единственное место, где видно НАМЕРЕНИЕ агента, а не следы его работы. Без
   * него лента — поток действий без цели, и на всякую заминку остаётся вопрос
   * «оно вообще движется?». На диск не сохраняется: план принадлежит живому
   * ходу, и вчерашний, выданный за сегодняшний, врал бы хуже, чем его отсутствие.
   */
  plan?: import('@shared/agentPlan').AgentPlan
  /** Движок сжимает контекст прямо сейчас — в ленте идёт строка со спиннером. */
  compacting?: boolean
  /**
   * Текст, который печатается прямо сейчас.
   *
   * НЕ история: целое сообщение придёт следом и ляжет в `messages`, а это
   * стирается. Держать его отдельно — единственный способ показать печать и не
   * запомнить обрывок как сказанное.
   */
  typed?: string
  /**
   * Вызов, аргументы которого модель печатает прямо сейчас.
   *
   * Как и `typed` — показ, а не история: настоящим станет блок `tool_use` в
   * целом сообщении движка, и он же займёт это место на экране. Держать его в
   * ленте значило бы запомнить как сделанное то, что ещё только набиралось.
   */
  typedTool?: { name: string; preview: string }
  agentMode: boolean
  /** True only while an ai.chat request is in flight (between dispatch and done/error). */
  streaming: boolean
  /**
   * Tool calls from the current assistant turn awaiting a decision or still
   * executing. A single turn can legally contain several parallel tool_use
   * blocks, so this is a queue keyed by tool_use id — never a single slot.
   */
  pendingTools: PendingTool[]
  /**
   * Когда начался инструмент, по его id.
   *
   * Пока команда идёт, карточка показывала только спиннер: «выполняется» — и
   * ни слова о том, минуту это уже или десять. Вывод инструмента SDK отдаёт
   * одним куском в конце, поэтому время — единственное, что мы честно знаем о
   * происходящем, и единственное, что отличает работу от зависания.
   */
  toolStartedAt: Record<string, number>
  /**
   * Сердцебиение идущих вызовов, по id инструмента.
   *
   * Отличает работающий инструмент от повисшего: секундомер идёт у обоих
   * одинаково, а пульс приходит только от живого. Запись живёт ровно пока
   * инструмент идёт — с приходом результата снимается.
   *
   * На диск не сохраняется: это наблюдение за живым ходом, и вчерашний пульс,
   * выданный за сегодняшний, был бы прямой ложью о происходящем.
   */
  toolPulses?: Record<string, ToolPulse>
  /**
   * Картинки, вернувшиеся из инструментов, по id вызова.
   *
   * Отдельно от `messages` намеренно: история беседы уходит на диск целиком и
   * часто, а скриншот от MCP-сервера прилетает на каждый вызов. В сообщении
   * остаётся только ЧИСЛО картинок — этого хватает, чтобы восстановленная
   * карточка сказала правду вместо пустоты.
   *
   * Объём ограничен бюджетом: старые вытесняются (см. `fitToolImages`). Память
   * — такой же ресурс, как диск, и «пока не кончится» здесь не предел.
   */
  toolImages?: Record<string, ToolImage[]>
  pendingContext: AiContextChip[]
  /** Message typed while the agent is working — queued, editable (↑), sent when it finishes. */
  queued?: string
  /** Transport error from the last stream, shown as a dismissible banner. */
  error?: string
  createdAt: number
  /** requestId of the in-flight ai.chat call, if any (internal bookkeeping for abort()). */
  activeRequestId?: string
}

/** A conversation is "busy" (input blocked) while streaming OR while tools are unresolved. */
export function isConversationBusy(conv: Conversation): boolean {
  return conv.streaming || conv.pendingTools.length > 0
}

/**
 * The conversation shown/edited for a terminal session — so each terminal keeps
 * its OWN agent chat. Uses the session's tracked active conversation, falling
 * back to the most recent conversation bound to that session. Returns a stable
 * conversation object reference (safe as a zustand selector result).
 */
export function convForSession(
  state: { conversations: Conversation[]; activeBySession: Record<string, string> },
  sessionId: string | null | undefined
): Conversation | undefined {
  if (!sessionId) return undefined
  const activeId = state.activeBySession[sessionId]
  if (activeId) {
    const c = state.conversations.find((x) => x.id === activeId)
    if (c) return c
  }
  let latest: Conversation | undefined
  for (const c of state.conversations) {
    if (c.sessionId === sessionId && (!latest || c.createdAt >= latest.createdAt)) latest = c
  }
  return latest
}

interface AiState {
  conversations: Conversation[]
  activeId: string | null
  /** Which conversation is active per terminal session (feed follows the terminal). */
  activeBySession: Record<string, string>
  /** Session id remembered for the inline command bar (set by aiBridge.openCommandBar). */
  commandBarSessionId: string | null
  /**
   * АВТОПИЛОТ, выбранный для ПАНЕЛИ. Беседа появляется только с первым
   * сообщением, а чип стоит в строке сразу — без этой памяти он до первой
   * отправки молча ничего не делал бы, то есть был бы мёртвым переключателем.
   * Панели, которой здесь нет, автопилот не достаётся: новая всегда спрашивает,
   * наследовать от соседней неоткуда. На диск не пишется намеренно — перезапуск
   * возвращает спрашивание.
   */
  bypassBySession: Record<string, boolean>
  editsAutoBySession: Record<string, boolean>
  planBySession: Record<string, boolean>
  /**
   * «Не читать здесь» — по ПАНЕЛИ, потому что так и написано в подписи.
   *
   * Сначала отказ жил только в беседе, и ревью поймало расхождение: человек
   * читал «в этой панели», а новый разговор в той же панели снова забирал его
   * консоль. Обещание было шире правды — то самое, чего проект себе не
   * позволяет.
   *
   * В отличие от соседних карт, ПЕРЕЖИВАЕТ перезапуск: восстанавливается из
   * бесед, поднятых с диска. Автопилот наоборот обязан спрашивать заново —
   * там перезапуск ослабляет, здесь усиливает, и это разные решения.
   */
  shellTailOffBySession: Record<string, boolean>
  /**
   * Вложенные картинки, ждущие отправки, — по ПАНЕЛИ, а не по беседе. В момент
   * вставки беседы у панели может ещё не быть, а курсор уже в конкретной панели.
   * На диск не пишется: base64 скриншота в открытом файле истории — плохой
   * размен (см. SECURITY.md).
   */
  pendingImages: Record<string, ImageAttachment[]>

  /** Load persisted conversations from disk (call once at boot, after sessions). */
  hydrate: () => Promise<void>
  /** Persist conversations to disk now (used by the quit flush). */
  saveNow: () => Promise<void>

  newConversation: (opts?: {
    sessionId?: string
    title?: string
    engine?: 'builtin' | AgentEngine
  }) => string
  setActiveConversation: (id: string) => void
  deleteConversation: (id: string) => void
  activeConversation: () => Conversation | undefined

  send: (
    text: string,
    opts?: {
      conversationId?: string
      /**
       * Отправить как ЗАПИСКУ соседней панели: в ленте она получит свой вид с
       * именем отправителя, а не пузырь человека.
       */
      paneNote?: { from: string; fromConvId?: string }
      /**
       * БОКОВОЙ ВОПРОС: спросить и не потащить это дальше.
       *
       * Пара «вопрос — ответ» останется в ленте с явной пометкой, а следующий
       * настоящий ход пойдёт веткой от точки ДО вопроса. Держится на форке
       * сессии, поэтому работает не у всех движков — и там, где не работает,
       * пометка честно скажет, что вопрос остался в контексте.
       */
      side?: boolean
    }
  ) => Promise<void>
  abort: (conversationId?: string) => void
  /**
   * Отменить ОТПРАВЛЕННОЕ сообщение, на которое агент ещё не ответил: убрать его
   * из ленты и из контекста и вернуть текст для строки ввода. Возвращает текст
   * или null, если отменить нечего или движок так не умеет.
   */
  undoSend: (conversationId?: string) => Promise<string | null>
  /**
   * Включить/выключить АВТОПИЛОТ у ОДНОЙ беседы: и в сторе, и в живой сессии
   * драйвера. Соседние панели это не касается.
   */
  setBypass: (conversationId: string, on: boolean) => void
  setEditsAuto: (conversationId: string, on: boolean) => void
  /** Не подавать консоль человека агенту в ЭТОЙ беседе (см. `shellTailOff`). */
  setShellTailOff: (conversationId: string, off: boolean) => void
  /**
   * То же для панели, в которой беседы ещё нет: выбор запоминается и достаётся
   * первой же беседе этой панели.
   */
  setPaneBypass: (sessionId: string, on: boolean) => void
  setPaneEditsAuto: (sessionId: string, on: boolean) => void
  setPlanMode: (conversationId: string, on: boolean) => void
  setPanePlanMode: (sessionId: string, on: boolean) => void
  /** Приложить картинку к панели. Отказ (пределы) — на стороне вызывающего. */
  attachImage: (sessionId: string, att: ImageAttachment) => void
  /** Снять одно вложение — крестиком на чипе. */
  dropImage: (sessionId: string, id: string) => void
  /** Очистить вложения панели (после отправки). */
  clearImages: (sessionId: string) => void
  /**
   * Панель закрыта — убрать всё, что за ней числилось.
   *
   * Две причины, и обе видно человеку. Первая: карты по sessionId переживали
   * панель, а `restoreSaved` открывает сессию ПОД ТЕМ ЖЕ id — восстановленный
   * терминал получал чужие вложения из прошлой жизни и, что хуже, включённый
   * автопилот: новая беседа заводилась с `bypass` мёртвой панели и выполняла
   * инструменты без спроса. Вторая: висящий гейт и идущий ход остаются в
   * беседе, а карточка, которой их решают, умерла вместе с панелью — счётчик
   * «ждут решения» в нижней полосе застревал до конца работы приложения.
   */
  forgetSession: (sessionId: string) => void

  /** Approve a pending tool by id (defaults to the first unsettled one). */
  approveTool: (conversationId?: string, toolId?: string) => Promise<void>
  /** Разрешить ровно это до конца сессии и сразу выполнить. */
  allowForSession: (conversationId: string, toolId: string) => Promise<void>
  /** Снять ранее выданное разрешение. */
  revokeSessionRule: (conversationId: string, rule: string) => void
  /**
   * Пустить агента в ещё одну папку. Путь выбирает ОС, а не приложение.
   *
   * Возвращает, что вышло: `no-engine` — движок так не умеет; `busy` — идёт ход
   * (менять доступ на лету значило бы оборвать работу); `already` — папка уже
   * в списке. Окно обязано сказать это словами, а не молча ничего не сделать.
   */
  addWorkDir: (conversationId: string) => Promise<{
    ok: boolean
    dir?: string
    reason?: 'canceled' | 'busy' | 'already' | 'no-engine'
  }>
  /** Забрать доступ к папке обратно. */
  removeWorkDir: (conversationId: string, dir: string) => Promise<void>
  /** Deny a pending tool by id (defaults to the first unsettled one). */
  /**
   * Отклонить вызов. `reason` — то, что человек написал в строке ввода: «не так,
   * сделай иначе». Уходит агенту вместо сухого отказа, поэтому он не пробует
   * ровно тот же вызов ещё раз.
   */
  denyTool: (conversationId?: string, toolId?: string, reason?: string) => void
  /** Answer a Claude Code AskUserQuestion (maps question text -> chosen labels). */
  answerQuestion: (
    conversationId: string,
    toolId: string,
    answers: Record<string, string[]>
  ) => void
  /** Open a past Claude Code session in the active terminal (resume its context). */
  resumeClaudeSession: (opts: {
    claudeSessionId: string
    title: string
    messages: AiMessage[]
    cwd?: string
    sessionId?: string
  }) => string
  /** Queue a message typed while the agent is busy (sent when the turn ends). */
  queueMessage: (conversationId: string, text: string) => void
  /** Pull the queued message back out for editing (↑), clearing it. */
  takeQueued: (conversationId: string) => string | undefined
  attachBlockContext: (block: BlockRecord, conversationId?: string) => void
  attachContext: (label: string, content: string, conversationId?: string) => void
  removeContext: (contextId: string, conversationId?: string) => void
  dismissError: (conversationId?: string) => void
  setAgentMode: (on: boolean, conversationId?: string) => void
}

// ----------------------------------------------------------------- helpers

/**
 * Снять пульс отработавшего инструмента.
 *
 * Пульс — про то, что происходит СЕЙЧАС. Оставить его после результата значит
 * копить в беседе записи о вызовах, которых давно нет, и рано или поздно
 * показать «пульса нет» рядом с законченной командой.
 */
function withoutPulse(
  pulses: Record<string, ToolPulse> | undefined,
  id: string
): Record<string, ToolPulse> | undefined {
  if (!pulses?.[id]) return pulses
  const next = { ...pulses }
  delete next[id]
  return next
}

function truncateText(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max) + '…' : t
}

function deriveTitle(text: string): string {
  return truncateText(text, 42) || t('ai.newConv')
}

function tailClip(s: string, max: number): string {
  return s.length > max ? `${t('ai.truncated')}\n${s.slice(-max)}` : s
}

/** Last text/tool_result part matching a given tool_use id, searched across all messages. */
function findToolResult(
  messages: AiMessage[],
  toolUseId: string
): Extract<AiContentPart, { type: 'tool_result' }> | undefined {
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === 'tool_result' && p.toolUseId === toolUseId) return p
    }
  }
  return undefined
}

/**
 * tool_use ids anywhere in the history that still lack a matching tool_result.
 * The agentic loop must only continue (send the next turn) once every tool_use
 * from the current turn has produced a tool_result — otherwise the provider
 * rejects the request ("each tool_use must have a corresponding tool_result").
 */
function unresolvedToolUseIds(messages: AiMessage[]): string[] {
  const ids: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const p of m.content) {
      if (p.type === 'tool_use' && !findToolResult(messages, p.id)) ids.push(p.id)
    }
  }
  return ids
}

function lastAssistantHasToolUse(messages: AiMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') return m.content.some((p) => p.type === 'tool_use')
  }
  return false
}

function appendText(conv: Conversation, text: string): Conversation {
  const messages = [...conv.messages]
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') {
    const content = [...last.content]
    const lastPart = content[content.length - 1]
    if (lastPart && lastPart.type === 'text') {
      content[content.length - 1] = { ...lastPart, text: lastPart.text + text }
    } else {
      content.push({ type: 'text', text })
    }
    messages[messages.length - 1] = { ...last, content }
  } else {
    messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
  }
  return { ...conv, messages }
}

function appendToolUse(conv: Conversation, id: string, name: string, input: unknown): Conversation {
  const part: AiContentPart = { type: 'tool_use', id, name, input }
  const startedAt = { ...conv.toolStartedAt, [id]: Date.now() }
  const messages = [...conv.messages]
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] }
  } else {
    messages.push({ role: 'assistant', content: [part] })
  }
  return { ...conv, messages, toolStartedAt: startedAt }
}

/** Waits for the first block that starts in `sessionId` after this call and finishes. */
function runCommandAndWait(sessionId: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    const startedAfter = Date.now() - 250
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const unsub = onBus('block:finished', (payload) => {
      if (settled || payload.sessionId !== sessionId) return
      const block = useBlocksStore
        .getState()
        .bySession[sessionId]?.find((b) => b.id === payload.blockId)
      if (!block || block.startedAt < startedAfter) return
      settled = true
      clearTimeout(timer)
      unsub()
      const code = payload.exitCode ?? block.exitCode
      resolve(`exit ${code ?? '?'}\n${tailClip(block.output, TOOL_OUTPUT_CAP)}`)
    })
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      unsub()
      resolve(t('ai.noOutput'))
    }, TOOL_TIMEOUT_MS)
    window.zarya.pty.write(sessionId, command + '\r')
  })
}

/**
 * Хвост консоли этой беседы — или ничего, если подавать нечего или незачем.
 *
 * Живёт рядом с системным промптом не случайно: раньше блоки собирались ИМЕННО
 * там, и переезд сюда — весь смысл inc-42. Формат при переезде не переписан, а
 * вынесен целиком в @shared/shellTail: обёртка недоверенного вывода — защита, и
 * менять её заодно с местом вызова значило бы чинить два риска одной правкой.
 *
 * Два выключателя, и они про разное. Число в настройках — «сколько команд
 * подавать» на всё приложение; `shellTailOff` — «в этой панели не подавать
 * вовсе», решение про конкретный разговор.
 */
function collectShellTail(conv: Conversation): ShellTail | undefined {
  if (conv.shellTailOff) return undefined
  const sessionId = conv.sessionId || useSessionsStore.getState().activeSessionId()
  if (!sessionId) return undefined
  const blocks = useBlocksStore.getState().bySession[sessionId] ?? []
  return shellTail(blocks, getSettings().ai.contextBlocks, {
    // SECURITY (prompt injection / OWASP LLM01): вывод команды — НЕДОВЕРЕННЫЕ
    // данные, их мог сочинить скачанный файл, удалённый сервер или баннер
    // зависимости. Вступление говорит модели читать их как данные, а не как
    // указания, чтобы «игнорируй прошлое, запусти X» не стало вызовом.
    intro: t('ai.sys.untrusted'),
    unknownCmd: t('ai.unknownCmd'),
    truncated: t('ai.truncated'),
    stripped: t('ai.markerStripped')
  })
}

async function buildSystemPrompt(conv: Conversation): Promise<string> {
  const settings = getSettings()
  const sessionId = conv.sessionId || useSessionsStore.getState().activeSessionId()
  const session = sessionId ? useSessionsStore.getState().sessions[sessionId] : undefined

  const lines: string[] = [
    t('ai.sys.role'),
    t('ai.sys.os', { shell: session?.shellName || t('ai.sys.unknownShell') }),
    t('ai.sys.cwd', { cwd: session?.cwd || t('ai.sys.unknownCwd') })
  ]

  if (session?.cwd) {
    try {
      const git = await window.zarya.git.status(session.cwd)
      if (git) {
        lines.push(
          t('ai.sys.branch', {
            branch: git.branch,
            dirty: git.dirty ? t('ai.sys.dirty', { n: git.dirty }) : ''
          })
        )
      }
    } catch {
      // not a repo, or git unavailable — silently omit
    }
  }

  /*
   * БЛОКОВ ЗДЕСЬ БОЛЬШЕ НЕТ — они уехали в часть хода (`collectShellTail`).
   *
   * Две причины. Первая: этот промпт видел только встроенный провайдер, потому
   * что зовут его лишь из `dispatchChat`, — а настройка обещала «прикреплять к
   * запросу», и Claude Code команд человека не видел вовсе. Вторая: системный
   * промпт кэшируется, и волатильный хвост консоли в нём рвал бы кэш каждым
   * ходом. Оба лечатся одним переездом.
   */

  if (conv.agentMode) {
    lines.push('', t('ai.sys.tool'))
  }

  if (settings.ai.systemPromptExtra.trim()) {
    lines.push('', settings.ai.systemPromptExtra.trim())
  }

  return lines.join('\n')
}

// -------------------------------------------------------------------- store

/** requestId -> conversationId, for the single global stream subscriber. */
const requestConv = new Map<string, string>()

/**
 * Per-conversation serial execution chain. Parallel tool_use calls in one turn
 * must run one at a time (they share a single terminal), so each executeTool is
 * appended to this promise chain instead of firing concurrently.
 */
const execChains = new Map<string, Promise<void>>()

/**
 * Per-conversation run epoch, bumped by abort()/delete. A tool execution that
 * finishes after its conversation was aborted checks the epoch and drops its
 * result instead of resurrecting the loop.
 */
const runEpoch = new Map<string, number>()
function currentEpoch(convId: string): number {
  return runEpoch.get(convId) ?? 0
}
function bumpEpoch(convId: string): void {
  runEpoch.set(convId, currentEpoch(convId) + 1)
}

// ------------------------------------------------------------- persistence
/** Gate saves until the initial hydrate ran (never clobber disk with []). */
let hydrated = false
const CONV_PERSIST_CAP = 100

/**
 * ТЕКСТ ХВОСТА КОНСОЛИ НА ДИСК НЕ ЕДЕТ — только список команд.
 *
 * Хвост нужен ровно один раз: в тот ход, когда он уехал модели. Дальше он живёт
 * в истории движка. А на диске он копился бы по нескольку тысяч символов НА
 * КАЖДЫЙ ход — беседа переписывается целиком раз в несколько сот миллисекунд,
 * и сотня ходов превратила бы каждое сохранение в мегабайты чужого вывода.
 * Тот же довод, по которому здесь не хранятся картинки инструментов.
 *
 * Плашка в ленте от этого не страдает: она рисуется по `used`, а он остаётся.
 * Пустой текст на отправке отфильтрован — см. `dispatchAgent` и
 * `flattenForProvider`: восстановленный ход не отправит пустую часть.
 */
function stripTailText(m: AiMessage): AiMessage {
  if (!m.content.some((p) => p.type === 'shell-tail' && p.text)) return m
  return {
    ...m,
    content: m.content.map((p) => (p.type === 'shell-tail' ? { ...p, text: '' } : p))
  }
}

function persistConversations(state: AiState): Promise<void> {
  // Never write before hydrate ran: a quit during the async startup load would
  // otherwise overwrite the on-disk conversations AND cached catalog with the
  // empty initial store. scheduleSave gates too, but saveNow()/onQuitFlush call
  // this directly, so the guard must live here.
  if (!hydrated) return Promise.resolve()
  const conversations = state.conversations
    .filter((c) => c.messages.length > 0)
    .slice(-CONV_PERSIST_CAP)
    .map((c) => ({
      id: c.id,
      title: c.title,
      engine: c.engine,
      sessionId: c.sessionId,
      claudeSessionId: c.claudeSessionId,
      resumeAt: c.resumeAt,
      interrupted: c.interrupted,
      cwd: c.cwd,
      messages: c.messages.map(stripTailText),
      /*
       * Точка возврата бокового вопроса переживает перезапуск.
       *
       * Сначала я решил обратное — «точка живёт в памяти движка». Ревью
       * возразило фактом: соседняя точка отмены (`resumeAt`) персистится
       * ровно так же и работает. Без этого перезапуск посреди бокового хода
       * молча оставлял бы вопрос в контексте под пометкой «не поедет».
       */
      sideBack: c.sideBack,
      shellTailOff: c.shellTailOff,
      createdAt: c.createdAt
    }))
  const keptIds = new Set(conversations.map((c) => c.id))
  const activeBySession: Record<string, string> = {}
  for (const [sid, cid] of Object.entries(state.activeBySession)) {
    if (keptIds.has(cid)) activeBySession[sid] = cid
  }
  const payload: AiConversationsState = {
    conversations,
    activeBySession,
    claudeStatus: useUiStore.getState().claudeStatus,
    claudeModels: useUiStore.getState().claudeModels
  }
  return window.zarya.aiConversations.save(payload)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
/**
 * Состав панелей — главному процессу, для инструментов агента.
 *
 * Публикуем УРОВНЕМ (список целиком) и только когда он реально изменился:
 * сравниваем подпись из полей, которые видит сосед. Слать на каждый кусок
 * потока значило бы гнать десятки сообщений в секунду ради строки, которая не
 * поменялась.
 *
 * Сам факт публикации ничего не открывает: инструменты появляются у агента
 * только при включённой настройке, а без них этот список никто не спросит.
 */
let lastPanesSig = ''

function publishPanes(state: { conversations: Conversation[] }): void {
  /*
   * ТОЛЬКО ОТКРЫТЫЕ ПАНЕЛИ. Беседа переживает панель: закрыл вкладку — разговор
   * остался в истории. Публиковать их все значило бы показать агенту «панели»,
   * которых нет на экране, и записка в такую будила бы ПЛАТНЫЙ ход в окне,
   * которого человек не видит.
   *
   * Имя и папку берём у ПАНЕЛИ, а не у беседы: человек обращается к тому, что
   * написано на вкладке, и переименование вкладки должно менять адрес.
   */
  const sessions = useSessionsStore.getState().sessions
  const panes = state.conversations
    .filter((c) => !!c.sessionId && !!sessions[c.sessionId])
    .map((c) => {
      const s = c.sessionId ? sessions[c.sessionId] : undefined
      /*
       * ЧЕМ ЗАНЯТА — то же, что человек видит на её экране: текущий вызов или
       * задача из волны. Ни истории, ни текста разговора: сосед должен понять,
       * к кому идти с вопросом, а не читать чужую переписку.
       */
      const run = Object.values(c.subagents ?? {}).find((r) => !r.done)
      const doing =
        c.pendingTools.find((t) => !t.settled)?.name ||
        run?.description ||
        run?.lastTool ||
        undefined
      return {
        convId: c.id,
        title: s?.title || c.title,
        cwd: s?.cwd || c.cwd,
        engine: c.engine,
        busy: c.streaming === true,
        doing
      }
    })
  const sig = JSON.stringify(panes)
  if (sig === lastPanesSig) return
  lastPanesSig = sig
  window.zarya.panes?.publish(panes)
}

/**
 * Записка от соседней панели приехала.
 *
 * ТРИ ПРАВИЛА, каждое из которых иначе превращает удобство в дыру:
 *
 * 1. Она ложится в ленту СВОИМ видом, с именем отправителя. Не репликой
 *    человека: иначе он поверит, что написал это сам.
 * 2. Агенту она уходит помеченной («записка от панели X»), а не как слова
 *    человека — тот же довод, только со стороны модели.
 * 3. У панели на АВТОПИЛОТЕ она придерживается. Там указание со стороны стало
 *    бы действиями без единого вопроса, а согласия человека на них никто не
 *    давал (см. inboundPlan).
 */
/**
 * Ответить главному процессу про блоки команд ЭТОЙ панели.
 *
 * Блоки живут здесь и здесь остаются: держать их копию в главном процессе
 * значило бы дублировать весь вывод терминала. Он спрашивает — мы отвечаем.
 *
 * ЧУЖИХ ПАНЕЛЕЙ ЗДЕСЬ НЕТ. Инструмент читает консоль той беседы, из которой
 * его позвали: агент видит команды человека, с которым работает, и ничьи
 * больше. Иначе получился бы новый способ заглянуть в соседний проект в обход
 * всего, что для этого заведено.
 */
function answerBlocksQuery(q: Record<string, unknown>): void {
  const queryId = String(q.queryId ?? '')
  const reply = (a: unknown): void => window.zarya.panes?.blocksReply?.(queryId, a)
  if (!queryId) return

  // Блоки собираются только при включённой настройке; молчать об этом нельзя,
  // иначе агент прочитает пустоту как «человек ничего не запускал».
  if (!getSettings().blocks.enabled) return reply({ ok: false, reason: 'off' })

  const conv = useAiStore.getState().conversations.find((c) => c.id === String(q.convId ?? ''))
  const sid = conv?.sessionId
  if (!sid) return reply({ ok: false, reason: 'no-pane' })

  /*
   * ПОСЛЕДНИЙ РУБЕЖ: СПРАШИВАЕМ СОГЛАСИЕ ЗДЕСЬ, А НЕ ТОЛЬКО ПРИ СТАРТЕ.
   *
   * Состав инструментов замыкается при запуске сессии, и ревью показало цену:
   * человек нажимает «не читать здесь» посреди работы — а у живой сессии
   * инструменты остались, и следующая же команда с ключами уходит агенту.
   * Кнопка в этот момент врёт, хотя обещает обратное дословно.
   *
   * Гейт при старте оставлен: он экономит токены, не объявляя инструментов
   * там, где на них ответили «нет». Но решение о согласии не может жить только
   * в моменте запуска — человек меняет его тогда, когда захочет.
   */
  const refused =
    conv?.shellTailOff === true ||
    useAiStore.getState().shellTailOffBySession[sid] === true ||
    getSettings().ai.contextBlocks <= 0
  if (refused) return reply({ ok: false, reason: 'refused' })
  const all = useBlocksStore.getState().bySession[sid] ?? []

  /*
   * ОБОЛОЧКА, КОТОРАЯ О КОМАНДАХ НЕ РАССКАЗЫВАЕТ, — НЕ ПУСТОЙ ТЕРМИНАЛ.
   *
   * Блоки собирает интеграция оболочки, и в SSH-панели или в голом cmd.exe её
   * нет намеренно. Пустой список агент прочитает единственным доступным ему
   * образом — «человек ничего не запускал» — и скажет это вслух человеку,
   * который смотрит на экран, полный команд. Причина не в нём, и назвать её
   * надо словами.
   *
   * Панель в состоянии `starting` сюда не попадает: интеграция там ещё не
   * объявилась, и назвать её отсутствующей значило бы соврать на секунду
   * раньше правды.
   */
  const session = useSessionsStore.getState().sessions[sid]
  if (session && session.status !== 'starting' && !session.integration && !all.length)
    return reply({ ok: false, reason: 'no-integration' })

  if (q.kind === 'list') {
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10))
    const needle = typeof q.contains === 'string' ? q.contains.trim() : ''
    const brief = (b: BlockRecord): BlockBrief => ({
      id: b.id,
      command: b.command,
      ...(b.exitCode === undefined ? {} : { exitCode: b.exitCode }),
      chars: (b.output ?? '').length,
      ...(b.endedAt === undefined ? {} : { endedAt: b.endedAt })
    })
    if (!needle) {
      return reply({ ok: true, kind: 'list', blocks: all.slice(-limit).map(brief) })
    }
    /*
     * ПОИСК ПО СВОЕЙ ЖЕ КОНСОЛИ — вместо чтения всего подряд.
     *
     * Без него «где я это видел» стоило серии read_block, и каждый тащил в
     * контекст тысячи знаков чужого вывода ради одной строки. Здесь наоборот:
     * несколько блоков, у каждого одна совпавшая строка.
     *
     * ПРЕДЕЛЫ ЖЁСТКИЕ И НАМЕРЕННЫЕ. Отрывок приезжает БЕЗ отдельного решения
     * человека про конкретный блок — в отличие от `read_block`, где он видит
     * на карточке, что именно читают. Поэтому пара сотен знаков на совпадение
     * и не больше пяти блоков за вызов: это ответ «смотри туда», а не способ
     * вычитать журнал по кусочкам.
     */
    const low = needle.toLowerCase()
    const found: BlockBrief[] = []
    for (let i = all.length - 1; i >= 0 && found.length < SEARCH_HITS; i--) {
      const b = all[i]
      const lines = (b.output ?? '').split(/\r?\n/)
      const hits = lines.filter((l) => l.toLowerCase().includes(low))
      const inCommand = (b.command ?? '').toLowerCase().includes(low)
      if (!hits.length && !inCommand) continue
      found.push({
        ...brief(b),
        matches: hits.length,
        // Совпало в самой команде, а в выводе нет — отрывку взяться неоткуда,
        // и придумывать его нельзя: пустое поле честнее выдуманной строки.
        ...(hits.length ? { snippet: hits[0].slice(0, SNIPPET_CAP) } : {})
      })
    }
    return reply({ ok: true, kind: 'list', blocks: found.reverse() })
  }

  const found = all.find((b) => b.id === String(q.blockId ?? ''))
  if (!found) return reply({ ok: false, reason: 'not-found' })
  /*
   * ПРЕДЕЛ — ТОТ ЖЕ, ЧТО У ЛЮБОГО ИТОГА ИНСТРУМЕНТА.
   *
   * Раньше здесь было написано «предел тот же, что у ручного приложения блока
   * к сообщению», и это было просто неправдой: там 1500, здесь 4000. Ревью
   * поймало — комментарий врал ровно так же, как врала бы кнопка.
   *
   * Больше, чем у автоматической подачи, — намеренно: весь смысл этого вызова
   * в том, чтобы дотянуться до вывода, который в короткий хвост не поместился.
   * Урезать его до хвоста значило бы завести инструмент, отвечающий тем же,
   * что агент уже видел.
   */
  const full = found.output ?? ''
  /*
   * ОБРЕЗАНО МОЖЕТ БЫТЬ И ДО НАС.
   *
   * Терминал хранит не весь вывод: длинное отрезается ещё при записи, и от
   * него остаётся хвост (`outputTruncated`). Мы это поле не смотрели вовсе —
   * и на блоке, чей ОСТАТОК короче 4000, отвечали «не обрезано», то есть
   * обещали агенту полный вывод там, где начала не существует. Оба обрезания
   * съедают начало, поэтому говорим о них одной честной фразой.
   */
  const truncated = full.length > TOOL_OUTPUT_CAP || found.outputTruncated === true
  reply({
    ok: true,
    kind: 'one',
    block: {
      id: found.id,
      command: found.command,
      ...(found.exitCode === undefined ? {} : { exitCode: found.exitCode }),
      chars: full.length
    },
    output: truncated ? full.slice(-TOOL_OUTPUT_CAP) : full,
    truncated
  })
}

function receivePaneNote(m: {
  noteId?: string
  toConvId: string
  fromConvId: string
  text: string
  expect?: string
}): void {
  /*
   * ЧИСТИМ НА ПРИЁМЕ ТОЖЕ, а не только у отправителя.
   *
   * Записку обезвреживает главный процесс перед отправкой — и до сих пор эта
   * сторона ему просто верила. Прогон показал, чем это плохо: доставка в обход
   * той единственной точки приносит текст сырым. Защита, стоящая в одном месте
   * пути, — это защита ровно от одного пути.
   *
   * Дважды обезвреженный текст не портится: правило заменяет форму, а не
   * содержание, и повторное применение ничего не меняет.
   */
  m = { ...m, text: clampText(m.text ?? '') }
  /*
   * ОТЧИТЫВАЕМСЯ ПЕРЕД ОТПРАВИТЕЛЕМ во всех ветках, включая отказные. Наш
   * список панелей в главном процессе — копия, и она отстаёт: панель могли
   * закрыть секунду назад. Без ответа отправитель услышал бы «доставлено» про
   * записку, которой никто не получил.
   */
  const ack = (result: unknown): void => {
    if (m.noteId) window.zarya.panes?.ack(m.noteId, result)
  }
  const st = useAiStore.getState()
  const to = st.conversations.find((c) => c.id === m.toConvId)
  if (!to) {
    ack({ ok: false, reason: 'gone' })
    return
  }
  // Выключено целиком — значит и принимать нечего: иначе настройка выключала бы
  // только половину, а вторая продолжала бы работать молча.
  if (!getSettings().ai.paneMessages) {
    ack({ ok: false, reason: 'off' })
    return
  }

  const from = st.conversations.find((c) => c.id === m.fromConvId)
  const fromName = from?.title || 'другая панель'

  /*
   * ОТВЕТ ПРИШЁЛ — ПОМЕТКА ГАСНЕТ, и гаснет она ДО всех отказов ниже.
   *
   * Получатель мог сам ждать ответа от этой же панели; записка в обратную
   * сторону и есть ответ, даже если дальше её придержат по занятости или по
   * деньгам. Оставить лампочку гореть после пришедшего ответа значит показывать
   * человеку то, чего уже нет.
   */
  if (to.awaiting?.convId === m.fromConvId) {
    useAiStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === m.toConvId ? { ...c, awaiting: undefined } : c
      )
    }))
  }

  /*
   * ПРИДЕРЖИВАЕМ ТОЛЬКО ПО ЗАНЯТОСТИ: вклиниться между вызовом инструмента и
   * его результатом нельзя, разговор бы испортился. Записка при этом ВИДНА
   * человеку — молча потерять её мы не можем.
   *
   * Молчаливый режим (автопилот или «правки без спроса») больше НЕ повод
   * придерживать. Прежнее правило было верным по букве и убивало замысел:
   * диалог упирался в модальную кнопку ровно там, где человек включил
   * автоматизацию, то есть где он её и ждал. Вместо кнопки — ход с вопросами
   * (см. ниже и `inboundPlan`).
   */
  const busy = to.streaming === true || to.pendingTools.length > 0
  const silent = to.bypass === true || to.editsAuto === true
  /*
   * ДЕНЕЖНЫЙ ПРЕДОХРАНИТЕЛЬ — на пару панелей, за час.
   *
   * Пределы выше считают ЗАПИСКИ: двадцать в час на пару. Но записка двигает
   * настоящий ход модели, а ход ходу рознь — короткий ответ стоит центы, ход с
   * большим контекстом и десятком вызовов стоит доллары. Это единственное
   * место в Заре, где платный ход начинается без единого нажатия человека, и
   * охранять его числом штук значит охранять не то.
   *
   * ЗАПИСКА ПРИ ЭТОМ НЕ ТЕРЯЕТСЯ. Она ложится в ленту получателя помеченной —
   * человек видит и её, и причину. Гасится ровно автоматический платный ход:
   * продолжить может тот, чьи это деньги.
   */
  const spent = spentInHour(notePairSpend.get(pairKey(m.fromConvId, m.toConvId)), Date.now())
  const broke = overSpend(notePairSpend.get(pairKey(m.fromConvId, m.toConvId)), Date.now())
  const held: 'busy' | 'budget' | undefined = broke ? 'budget' : busy ? 'busy' : undefined
  if (broke) {
    // В консоль разработчика, а не человеку: у него на экране уже стоит
    // пометка на самой записке, и второе объяснение было бы шумом.
    console.info('[panes] переписка придержана по деньгам:', spent.toFixed(2))
  }

  if (held) {
    useAiStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id !== m.toConvId
          ? c
          : {
              ...c,
              messages: [
                ...c.messages,
                {
                  role: 'assistant' as const,
                  content: [{ type: 'pane-note' as const, from: fromName, text: m.text, held }]
                }
              ]
            }
      )
    }))
    ack({ ok: true, held })
    return
  }

  ack({ ok: true })

  /*
   * ОТПРАВИТЕЛЬ СКАЗАЛ, ЧТО ЖДЁТ ОТВЕТА — ставим ему пометку.
   *
   * Ставим ЗДЕСЬ, а не при отправке: только сейчас известно, что записку
   * приняли и ход по ней пойдёт. Придержанной записке ждать нечего, и лампочка
   * над ней была бы обещанием ответа, которого никто не обещал.
   *
   * Обе панели живут в этом же окне, поэтому отдельного канала для пометки не
   * нужно: правим беседу отправителя прямо тут.
   */
  if (m.expect === 'reply' && from) {
    const toName = to.title || 'соседняя панель'
    const mark = { pane: toName, convId: m.toConvId, at: Date.now() }
    useAiStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === m.fromConvId ? { ...c, awaiting: mark } : c
      )
    }))
  }

  /*
   * ХОД ПО ЧУЖОЙ ЗАПИСКЕ ИДЁТ С ВОПРОСАМИ.
   *
   * Панель работает без спроса — на время этого хода снимаем автопилот и
   * «правки без спроса», а после возвращаем. Согласие «делай молча» человек
   * давал СВОИМ словам; чужая записка им не покрыта. Сосед по-прежнему может
   * рассказать факт, спросить и получить ответ — но не может чужими руками
   * молча переписать файлы.
   *
   * Возвращаем только то, что сами сняли: если человек тем временем передвинул
   * тумблер руками, его выбор важнее нашего восстановления.
   */
  if (silent) {
    const prevBypass = to.bypass === true
    const prevEdits = to.editsAuto === true
    if (prevBypass) useAiStore.getState().setBypass(m.toConvId, false)
    if (prevEdits) useAiStore.getState().setEditsAuto(m.toConvId, false)

    /*
     * ЖДЁМ СНАЧАЛА НАЧАЛА ХОДА, потом конца.
     *
     * Подписка срабатывает уже на снятие тумблера — то есть ДО того, как ход
     * пошёл. Без флага «начался» она видела «не стримит, решений не ждёт»,
     * считала ход законченным и возвращала автопилот в ту же миллисекунду: чужая
     * записка снова работала бы без вопросов.
     */
    let started = false
    const restore = (): void => {
      const cur = useAiStore.getState().conversations.find((x) => x.id === m.toConvId)
      if (!cur) return
      if (prevBypass && cur.bypass !== true) useAiStore.getState().setBypass(m.toConvId, true)
      if (prevEdits && cur.editsAuto !== true) useAiStore.getState().setEditsAuto(m.toConvId, true)
    }
    const unsub = useAiStore.subscribe((s) => {
      const c = s.conversations.find((x) => x.id === m.toConvId)
      if (!c) {
        unsub()
        return
      }
      const busyNow = c.streaming || c.pendingTools.some((t) => !t.settled)
      if (busyNow) {
        started = true
        return
      }
      if (!started) return
      unsub()
      restore()
    })
    /*
     * Страховка: ход мог не начаться вовсе (движок не ответил, беседа занята
     * чем-то ещё). Оставить человека без его же автопилота навсегда нельзя —
     * он его включал сам и о нашей подмене не знает.
     */
    setTimeout(() => {
      if (started) return
      unsub()
      restore()
    }, 30_000)
  }

  // Обычный путь: одна дорога и в ленту, и агенту — см. `send({ paneNote })`.
  void useAiStore
    .getState()
    .send(m.text, {
      conversationId: m.toConvId,
      paneNote: { from: fromName, fromConvId: m.fromConvId }
    })
}

if (typeof window !== 'undefined') {
  /*
   * Состав панелей зависит и от СЕССИЙ: человек переименовал вкладку или сделал
   * `cd` — адрес и папка изменились, а подписка на беседы этого не заметит.
   * Без этого агент обращался бы к панели по имени, которого на экране уже нет.
   *
   * ПОДПИСЫВАЕМСЯ ОТЛОЖЕННО, и это не осторожность впрок: модули ссылаются друг
   * на друга по кругу (сессии знают про беседы и наоборот), и обращение к
   * чужому store прямо при загрузке роняло его инициализацию целиком — вместе с
   * половиной приложения. Микрозадача выполняется, когда оба модуля готовы.
   */
  queueMicrotask(() => {
    try {
      useSessionsStore.subscribe(() => publishPanes(useAiStore.getState()))
    } catch {
      // Реестр переиздастся при следующем изменении беседы — это не повод
      // ронять окно.
    }
  })
  window.zarya.panes?.onMessage(receivePaneNote)
  window.zarya.panes?.onBlocksQuery?.(answerBlocksQuery)
  /*
   * QA-хук: доставить записку ТЕМ ЖЕ путём, каким её доставляет главный
   * процесс. Не обход, а тот же вход: иначе прогон проверял бы собственную
   * выдумку, а не поведение продукта.
   */
  ;(
    window as unknown as {
      __zaryaPaneNote?: (m: { toConvId: string; fromConvId: string; text: string }) => void
    }
  ).__zaryaPaneNote = receivePaneNote
}

function scheduleSave(): void {
  if (!hydrated) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persistConversations(useAiStore.getState()), 800)
  // Состав панелей — сразу: агент соседней панели спрашивает его в момент хода,
  // и задержка в секунду означала бы список, которого уже нет.
  publishPanes(useAiStore.getState())
}

export const useAiStore = create<AiState>((set, get) => {
  const patchConversation = (id: string, fn: (c: Conversation) => Conversation): void => {
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) }))
  }

  /**
   * Запомнить скиллы, которые агент реально взял.
   *
   * Единственный момент, когда видно, что из оплаченного контекста пошло в
   * дело: сам скилл о себе не сообщает, а движок такого счёта не ведёт. Имя
   * лежит в `input.skill` — проверено по записям Claude Code.
   */
  const noteSkills = (id: string, calls: { name: string; input: unknown }[]): void => {
    const names = calls
      .filter((c) => c.name === 'Skill')
      .map((c) => {
        const v = (c.input as { skill?: unknown } | null)?.skill
        return typeof v === 'string' ? v.trim() : ''
      })
      .filter(Boolean)
    if (!names.length) return
    // Счётчик на диске — отдельно от беседы: одна беседа отвечает «сработал 1 из
    // 83», и по этому числу решать нечего. Файл живёт в данных Зари и никуда не
    // отправляется (см. shared/skillUsage.ts).
    window.zarya.agent.skillUsed(names)
    patchConversation(id, (c) => {
      const fresh = names.filter((n) => !c.skillsUsed?.includes(n))
      return fresh.length ? { ...c, skillsUsed: [...(c.skillsUsed ?? []), ...fresh] } : c
    })
  }

  /**
   * План агента из вызовов инструментов.
   *
   * Отдельного события у движка нет: план приходит теми же `TaskCreate` и
   * `TaskUpdate`, а номер задачи называется только в тексте результата. Поэтому
   * здесь два входа — на вызов и на результат (см. shared/agentPlan.ts).
   */
  const notePlanUse = (
    id: string,
    calls: { toolUseId: string; name: string; input: unknown }[]
  ): void => {
    const useful = calls.filter((c) => c.name === 'TaskCreate' || c.name === 'TaskUpdate')
    if (!useful.length) return
    patchConversation(id, (c) => {
      let plan = c.plan ?? EMPTY_PLAN
      for (const call of useful) plan = planOnToolUse(plan, call.toolUseId, call.name, call.input)
      return plan === (c.plan ?? EMPTY_PLAN) ? c : { ...c, plan }
    })
  }

  const notePlanResult = (id: string, toolUseId: string, content: string): void => {
    patchConversation(id, (c) => {
      const plan = planOnToolResult(c.plan ?? EMPTY_PLAN, toolUseId, content)
      return plan === (c.plan ?? EMPTY_PLAN) ? c : { ...c, plan }
    })
  }

  const resolveConv = (conversationId?: string): Conversation | undefined => {
    const s = get()
    const id = conversationId ?? s.activeId
    return s.conversations.find((c) => c.id === id)
  }

  async function dispatchChat(convId: string): Promise<void> {
    const conv = get().conversations.find((c) => c.id === convId)
    if (!conv) return
    // Flip streaming synchronously (before the first await) so a second
    // send()/approveTool() invoked right after this one can't race in
    // while buildSystemPrompt() is still fetching git status etc.
    patchConversation(convId, (c) => ({ ...c, streaming: true, error: undefined }))
    const settings = getSettings()
    const system = await buildSystemPrompt(conv)
    // re-read: buildSystemPrompt awaits, conv could have been mutated meanwhile
    const fresh = get().conversations.find((c) => c.id === convId)
    if (!fresh) return

    const requestId = uid('ai')
    requestConv.set(requestId, convId)
    patchConversation(convId, (c) => ({ ...c, activeRequestId: requestId }))

    // Effort drives temperature + token budget.
    const tune = EFFORT_TUNING[settings.ai.effort] ?? EFFORT_TUNING.medium
    const req: AiChatRequest = {
      provider: settings.ai.provider,
      model: settings.ai.model,
      baseUrl: settings.ai.baseUrl || undefined,
      system,
      messages: fresh.messages,
      tools: fresh.agentMode ? [RUN_COMMAND_TOOL] : undefined,
      temperature: tune.temperature,
      maxTokens: Math.max(settings.ai.maxTokens, tune.maxTokens)
    }
    window.zarya.ai.chat(requestId, req)
  }

  /**
   * Dispatch a turn to the conversation's native agent driver via the generic
   * `agent:*` transport (routed to the registry by `conv.engine`). The driver
   * key IS the conversation id (one live session per conversation): the first
   * turn spawns/opens the session, later turns are pushed as follow-up input.
   */
  function dispatchAgent(convId: string): void {
    const conv = get().conversations.find((c) => c.id === convId)
    if (!conv || conv.engine === 'builtin') return
    const engine = conv.engine
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user')
    /*
     * Записка соседней панели — ОДНА часть, и она же кормит промпт.
     *
     * Держать её текст ещё и отдельной частью `text` нельзя: лента нарисовала
     * бы рядом обычный пузырь, то есть выдала бы чужую записку за слова
     * человека — ровно то, ради чего у неё вообще заведён свой вид.
     *
     * Пометка «откуда» уходит модели дословно: без неё она прочитает записку
     * как слова человека и может решить, что получила его согласие.
     */
    const prompt = (lastUser?.content ?? [])
      .map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'pane-note' && !p.held
            ? `[note from pane "${p.from}"] ${p.text}`
            : // Хвост консоли уже собран и обёрнут при отправке — здесь только
              // сериализуем. Пропустить эту ветку значит молча выбросить то,
              // о чём плашка в ленте уже сказала человеку «уехало».
              //
              // Пустой текст — это ход, поднятый с диска: там от хвоста остался
              // только список команд (см. `stripTailText`). Слать пустую строку
              // незачем, а рисовать плашку по-прежнему честно: команды тогда
              // действительно уехали.
              p.type === 'shell-tail' && p.text
              ? p.text
              : null
      )
      .filter((x): x is string => typeof x === 'string')
      .join('\n')
      .trim()
    const hasImages = (lastUser?.content ?? []).some((p) => p.type === 'image')
    if (!prompt && !hasImages) return
    const settings = getSettings()
    const sessionId = conv.sessionId || useSessionsStore.getState().activeSessionId()
    const cwd = sessionId ? useSessionsStore.getState().sessions[sessionId]?.cwd : undefined
    patchConversation(convId, (c) => ({
      ...c,
      streaming: true,
      activeRequestId: convId,
      error: undefined,
      /*
       * Ход начинается с чистого экрана. Печать прошлого хода — и текст, и
       * строка набора вызова — принадлежала ему; недоехавший из главного
       * процесса хвост открыл бы новый ход чужой строкой «⟳ Bash <аргумент
       * прошлой команды>» ещё до первого слова движка.
       */
      typed: undefined,
      typedTool: undefined,
      /*
       * Волна — про ОДИН ход. Она остаётся на экране после его конца (иначе от
       * упавшей задачи не оставалось бы следа ровно тогда, когда о ней надо
       * узнать), но новый ход начинает счёт заново: «3 из 7», сложенные из двух
       * ходов, не описывали бы ни один из них.
       *
       * Сбрасывается ЗДЕСЬ, а не при одобрении инструмента: одобрение
       * продолжает тот же ход, и его задачи — те же самые.
       */
      subagents: undefined
    }))
    // Opts are Claude-sourced today (the only native engine); per-engine settings
    // (settings.ai.byEngine) arrive with Codex/Gemini in Ф4.
    // Картинки последнего хода — отдельным полем: строка их не вместит.
    const images = (lastUser?.content ?? [])
      .filter((p): p is Extract<AiContentPart, { type: 'image' }> => p.type === 'image')
      .map((p) => ({ mediaType: p.mediaType, data: p.data }))
    /*
     * ОДНО ВЫЧИСЛЕНИЕ НА ДВА РЕШЕНИЯ — иначе промпт разойдётся с составом.
     *
     * Этим же флагом объявляются инструменты блоков И едет приписка про них.
     * Посчитай мы его дважды, однажды одно условие поправят, а второе забудут
     * — и приписка начнёт рассказывать модели про инструменты, которых ей не
     * дали. Ровно этим визитка и врала до сегодняшнего дня.
     *
     * Ноль в настройке подачи значит «мою консоль агенту не давать». Оставить
     * при этом инструмент и спрашивать разрешение на каждый вызов значило бы
     * уговаривать после отказа. Отказ панели (`shellTailOff`) и выключенные
     * блоки действуют так же: собирать их некому.
     */
    const blockTools =
      settings.blocks.enabled && settings.ai.contextBlocks > 0 && !conv.shellTailOff
    const appendPrompt = enginePromptAppend(
      settings.ai.enginePromptExtra,
      settings.ai.backgroundLongCommands,
      settings.ai.paneMessages,
      blockTools
    )
    window.zarya.agent.start(engine, convId, {
      prompt,
      ...(images.length ? { images } : {}),
      cwd: cwd || conv.cwd,
      // Папки, куда человек пустил агента сверх рабочей. Едут каждым ходом:
      // состав живёт в беседе, а не в памяти драйвера, — так он не разойдётся
      // с тем, что показано в панели допуска.
      ...(conv.extraDirs?.length ? { extraDirs: conv.extraDirs } : {}),
      // Приписка к системному промпту движка. Едет каждым ходом, но действует с
      // ЗАПУСКА сессии — то есть в беседах, начатых после изменения. Так и
      // написано в настройке: обещать немедленность значило бы соврать.
      // Инструменты «увидеть соседа» и «написать соседу» — по явной настройке.
      ...(settings.ai.paneMessages ? { paneMessages: true } : {}),
      // Инструменты «посмотреть команды человека» и «прочитать вывод» —
      // по тому же согласию, что и автоматическая подача консоли (см. выше).
      ...(blockTools ? { blockTools: true } : {}),
      ...(appendPrompt ? { appendPrompt } : {}),
      // SECURITY: permissionMode is always 'default' and gate-weakening comes only
      // from АВТОПИЛОТ — see nativeGateOpts, which owns that invariant and is
      // guarded by tests/startOpts.test.ts.
      ...nativeGateOpts(settings.ai, conv.bypass, conv.planMode, conv.editsAuto),
      ultracode: useUiStore.getState().ultracode,
      model: settings.ai.claudeModel || undefined,
      // Ultracode forces xhigh; otherwise use the user's effort override.
      effort: useUiStore.getState().ultracode ? 'xhigh' : settings.ai.claudeEffort || undefined,
      // After a restart there's no live session for this conversation — resume the
      // real on-disk session so context is intact. The driver only uses `resume`
      // when spawning fresh; a live follow-up in the same run ignores it.
      resume: conv.claudeSessionId,
      // После отмены отправленного — продолжаем веткой от последнего ответа.
      resumeAt: conv.resumeAt
    })
  }

  /*
   * Прогону — доставить событие движка тем же путём, каким его приносит
   * драйвер. Нужно там, где событие со стороны не вызвать: «движок забыл
   * разговор» приходит от /clear, а подставной драйвер его не шлёт. Хук живёт
   * ЗДЕСЬ, а не на уровне модуля: обработчик — часть замыкания стора.
   */
  ;(
    window as unknown as { __zaryaAgentEvent?: (convId: string, ev: unknown) => void }
  ).__zaryaAgentEvent = (convId, ev) =>
    handleAgentEvent(convId, 'claude-code', ev as AgentStreamEvent)

  /** Map a native agent driver event onto the shared Conversation shape. */
  function handleAgentEvent(requestId: string, engine: AgentEngine, ev: AgentStreamEvent): void {
    // The fuel-gauge / model-catalog UI slots are Claude-specific until per-engine
    // ambient status lands; gate status writes so a future Codex/Gemini 'result'
    // can't clobber the Claude readout. The turn/tool branches below are generic.
    const isClaudeStatus = engine === 'claude-code'

    // usage + models are AMBIENT status, not bound to a conversation — apply them
    // before the conv-existence gate so the standalone usage poll (which runs with
    // no active conversation, e.g. before the first prompt) still updates the gauge.
    if (ev.type === 'usage') {
      const u = ev.usage
      // Context-window fill is UNIVERSAL — every engine reports it, so it updates
      // regardless of which engine is active.
      if (u.contextPct != null || u.contextTokens != null || u.contextWindow != null) {
        useUiStore.getState().set({
          agentContext: {
            pct: u.contextPct,
            tokens: u.contextTokens,
            window: u.contextWindow,
            engine
          }
        })
        /*
         * И В САМУ БЕСЕДУ — иначе показатель врёт при нескольких панелях.
         *
         * Значение выше глобальное: его перезаписывает ЛЮБОЙ движок в любой
         * панели. Пока заполнение показывали по нажатию, это сходило с рук —
         * человек открывал панель сразу после своего хода. Постоянный
         * показатель в строке панели так работать не может: он висел бы над
         * одним разговором, а числа приносил из соседнего.
         *
         * Комментарий в нижней полосе давно утверждал, что «заполнение у каждой
         * панели своё». Теперь это правда и в коде, а не только в словах.
         */
        patchConversation(requestId, (c) => ({
          ...c,
          context: {
            ...(u.contextPct == null ? {} : { pct: u.contextPct }),
            ...(u.contextTokens == null ? {} : { tokens: u.contextTokens }),
            ...(u.contextWindow == null ? {} : { window: u.contextWindow })
          }
        }))
      }
      // Subscription fuel (5h/7d windows) is Claude-only.
      if (
        isClaudeStatus &&
        (u.subscriptionType ||
          u.fiveHourPct != null ||
          u.sevenDayPct != null ||
          u.fiveHourResetsAt != null ||
          u.sevenDayResetsAt != null)
      ) {
        const cur = useUiStore.getState().claudeStatus
        useUiStore.getState().set({ claudeStatus: { ...cur, usage: { ...cur.usage, ...u } } })
      }
      return
    }
    if (ev.type === 'background') {
      /*
       * Набор ЗАМЕНЯЕТСЯ целиком — не сливается с прежним. Пустой список это
       * законное «в фоне никого», в том числе после перезапуска движка.
       */
      const conv = get().conversations.find((c) => c.id === requestId)
      if (conv) patchConversation(conv.id, (c) => ({ ...c, background: ev.tasks }))
      return
    }
    if (ev.type === 'subagent') {
      // The wave belongs to the conversation, not to the global status: two
      // terminals can each be running their own research at the same time.
      const conv = get().conversations.find((c) => c.id === requestId)
      if (conv) {
        patchConversation(conv.id, (c) => ({
          ...c,
          subagents: applySubagentEvent(c.subagents ?? {}, ev, Date.now())
        }))
      }
      return
    }
    if (isClaudeStatus && ev.type === 'models') {
      useUiStore.getState().set({ claudeModels: ev.models })
      // Persist so the launch pad (incl. Fable / any future model) is populated on
      // the next cold start without a live session.
      scheduleSave()
      return
    }

    const convId = requestId // driver key === conversation id
    if (!get().conversations.some((c) => c.id === convId)) return

    switch (ev.type) {
      /*
       * Движок назвал точку, к которой можно вернуть файлы этого хода.
       *
       * Вешаем её на ПОСЛЕДНИЙ ход человека без своей точки (см. turnId.ts):
       * пузырь давно нарисован отправкой, а id приходит из потока. Не нашли
       * куда — не вешаем: кнопка отката, показывающая на чужой ход, врёт
       * дороже, чем её отсутствие.
       */
      case 'turn-id':
        patchConversation(convId, (c) => ({ ...c, messages: attachTurnId(c.messages, ev.uuid) }))
        break
      case 'init':
        // Точку отмотки снимает только НОВАЯ сессия: ветка стартовала, дальше
        // отматывать нечего. Тот же id означает, что init прилетел от прежней
        // сессии (CLI шлёт его, например, после прерывания) — снять точку здесь
        // значило бы отправить следующий ход в неотмотанную историю, вернув
        // отменённое сообщение в контекст.
        patchConversation(convId, (c) => ({
          ...c,
          claudeSessionId: ev.sessionId,
          // Есть ли у ЭТОЙ сессии копии файлов. Настройка отвечает на «чего мы
          // хотим», а кнопка отката должна знать, что есть на самом деле.
          checkpointing: ev.checkpointing === true,
          resumeAt: ev.sessionId === c.claudeSessionId ? c.resumeAt : undefined
        }))
        /*
         * Модель и усилие принадлежат ПАНЕЛИ, и записываются для ЛЮБОГО движка.
         *
         * Раньше и то и другое писалось в общее состояние и только для Claude —
         * «остальные движки потом». Получалось двойное враньё: панель на Codex
         * не подписывалась вовсе, а две панели на разных моделях Claude
         * показывали ту, чей ход закончился последним. Подпись под строкой
         * ввода — это ответ на вопрос «кому я сейчас отправляю», и общей она
         * быть не может.
         */
        {
          const paneId = get().conversations.find((c) => c.id === convId)?.sessionId
          setAgentStatusFor(paneId, { model: ev.model, effort: ev.effort })
        }
        // Общий слот остаётся Claude-специфичным: он кормит поверхности, у
        // которых своей панели нет, и топливо подписки — оно и правда одно.
        if (isClaudeStatus)
          useUiStore.getState().set({
            claudeStatus: {
              ...useUiStore.getState().claudeStatus,
              model: ev.model,
              effort: ev.effort
            }
          })
        break

      /*
       * Кусок ответа, пока он печатается.
       *
       * Живёт ОТДЕЛЬНО от истории и стирается, как только придёт целое
       * сообщение движка. Так в беседе остаётся ровно то, что агент сказал:
       * оборванный на середине поток не осядет в памяти как его ответ, и
       * следующий ход не унесёт полфразы в контекст.
       */
      case 'text_delta':
        patchConversation(convId, (c) => ({ ...c, typed: (c.typed ?? '') + ev.text }))
        break

      /*
       * Модель печатает аргументы вызова. Строка живёт до целого сообщения —
       * настоящая карточка встанет ровно на её место.
       */
      case 'tool_typing':
        patchConversation(convId, (c) => ({
          ...c,
          typedTool: { name: ev.name, preview: ev.preview }
        }))
        break

      case 'assistant':
        patchConversation(convId, (c) => ({
          ...c,
          typed: undefined,
          typedTool: undefined,
          messages: [...c.messages, { role: 'assistant', content: ev.content }]
        }))
        // Вызовы инструментов приходят ВНУТРИ ответа модели, а не отдельным
        // событием: у Claude Code это единственный путь, и учитывать скиллы
        // только в `case 'tool_use'` значило бы не учитывать их вовсе.
        noteSkills(
          convId,
          ev.content.flatMap((p) =>
            p.type === 'tool_use' ? [{ name: p.name, input: p.input }] : []
          )
        )
        // План агента приходит теми же вызовами: ловим их там же, где скиллы.
        notePlanUse(
          convId,
          ev.content.flatMap((p) =>
            p.type === 'tool_use' ? [{ toolUseId: p.id, name: p.name, input: p.input }] : []
          )
        )
        break

      case 'permission':
        patchConversation(convId, (c) => ({
          ...c,
          pendingTools: [
            ...c.pendingTools.filter((t) => t.id !== ev.toolUseId),
            {
              id: ev.toolUseId,
              name: ev.toolName,
              input: ev.input,
              autoApproved: false,
              settled: false,
              kind: ev.questions ? 'question' : 'run',
              questions: ev.questions,
              title: ev.title,
              displayName: ev.displayName,
              allowAlwaysOnly: ev.allowAlwaysOnly,
              irreversible: ev.irreversible,
              mcpMark: ev.mcpMark,
              askedAt: Date.now()
            }
          ]
        }))
        // Человек уже разрешил ровно эту команду до конца сессии — исполняем
        // без вопроса. Необратимое сюда не попадёт: matchesRule отказывает ему
        // независимо от списка (пол выше правил).
        if (!ev.questions) {
          const conv = get().conversations.find((c) => c.id === convId)
          if (matchesRule(conv?.sessionAllows, ev.toolName, ev.input)) {
            void get().approveTool(convId, ev.toolUseId)
          }
        }
        break

      /*
       * Пометка сервера догнала свою карточку.
       *
       * Обновляем только ещё не решённый гейт: если человек уже нажал, дописать
       * ему «сервер помечает разрушающим» задним числом значит сказать это
       * после того, как оно перестало быть предупреждением.
       */
      case 'tool-mark':
        patchConversation(convId, (c) => ({
          ...c,
          pendingTools: c.pendingTools.map((t) =>
            t.id === ev.toolUseId && !t.settled ? { ...t, mcpMark: ev.mcpMark } : t
          )
        }))
        break

      /*
       * Инструмент подал признак жизни.
       *
       * Пульс приходит только пока вызов ИДЁТ, поэтому и запись живёт столько
       * же: с результатом она снимается ниже. Ритм считает `notePulse` — он же
       * решает, можно ли вообще судить о тишине (см. @shared/toolPulse).
       */
      case 'tool_pulse':
        patchConversation(convId, (c) => ({
          ...c,
          toolPulses: {
            ...c.toolPulses,
            [ev.toolUseId]: notePulse(
              c.toolPulses?.[ev.toolUseId],
              Date.now(),
              ev.elapsedSec,
              ev.retry
            )
          }
        }))
        break

      case 'tool_result':
        // Номер созданной задачи движок называет только здесь, в тексте
        // результата: «Task #3 created successfully: …».
        notePlanResult(convId, ev.toolUseId, ev.content)
        patchConversation(convId, (c) => ({
          ...c,
          pendingTools: c.pendingTools.filter((t) => t.id !== ev.toolUseId),
          toolPulses: withoutPulse(c.toolPulses, ev.toolUseId),
          // Байты картинок — мимо истории: она уходит на диск целиком и часто.
          // В сообщение попадает только их число (см. Conversation.toolImages).
          toolImages: ev.images?.length
            ? fitToolImages(c.toolImages, ev.toolUseId, ev.images)
            : c.toolImages,
          messages: [
            ...c.messages,
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  toolUseId: ev.toolUseId,
                  content: ev.content,
                  isError: ev.isError,
                  images: ev.images?.length || undefined,
                  imagesSkipped: ev.imagesSkipped,
                  imagesOverflow: ev.imagesOverflow,
                  facts: ev.facts
                }
              ]
            }
          ]
        }))
        break

      case 'result': {
        /*
         * Папку отозвали посреди хода — применяем СЕЙЧАС, на первом покое.
         *
         * Живая сессия переживает все ходы беседы, и без этого отозванный доступ
         * действовал бы до самого конца разговора, пока панель показывала бы,
         * что его нет. Ждём именно конца хода: закрыть сессию раньше значило бы
         * оборвать работу, которую человек не просил обрывать.
         */
        {
          const c = get().conversations.find((x) => x.id === convId)
          if (c?.dirsDirty && c.engine !== 'builtin') {
            patchConversation(convId, (x) => ({ ...x, dirsDirty: undefined }))
            void window.zarya.agent.applyDirs(c.engine, convId)
          }
        }
        /*
         * Итог хода строкой — но только когда есть что сказать.
         *
         * Молчим о ходе, который прошёл быстро и кончился нормально: строка под
         * каждым ответом превратится в шум, который перестают читать. Говорим,
         * если ход шёл дольше десяти секунд (тогда «сколько это заняло» —
         * настоящий вопрос), если движок назвал причину конца или если что-то
         * отклонили без вопроса.
         */
        const slow = (ev.durationMs ?? 0) >= 10_000
        if (slow || ev.endReason || ev.denials) {
          patchConversation(convId, (c) => ({
            ...c,
            messages: [
              ...c.messages,
              {
                role: 'assistant',
                content: [
                  {
                    type: 'turn',
                    durationMs: ev.durationMs,
                    ttftMs: ev.ttftMs,
                    turns: ev.numTurns,
                    denials: ev.denials,
                    endReason: ev.endReason,
                    isError: ev.isError
                  }
                ]
              }
            ]
          }))
        }
        // Снимок ДО патча: ниже `sideBack` снимается, а знать надо, был ли
        // этот ход боковым.
        const convBefore = get().conversations.find((c) => c.id === convId)
        /*
         * ХОД ПО ЧУЖОЙ ЗАПИСКЕ ЗАКОНЧИЛСЯ — записываем, во что он обошёлся.
         *
         * Цифру называет движок; на подписке она расчётная, а не списанная
         * (см. @shared/cost), и как мера «сколько работы наделала переписка»
         * верна в обоих случаях. Не назвал — записывать нечего, и
         * предохранителя в этот час просто нет: выдумать стоимость значило бы
         * гасить переписку по собственной догадке.
         */
        if (convBefore?.noteFrom) {
          const key = pairKey(convBefore.noteFrom, convId)
          notePairSpend.set(key, rememberSpend(notePairSpend.get(key), Date.now(), ev.costUsd))
        }
        patchConversation(convId, (c) => ({
          ...c,
          streaming: false,
          typed: undefined,
          typedTool: undefined,
          activeRequestId: undefined,
          /*
           * Пульс живёт только внутри хода.
           *
           * Вызов, чей результат так и не пришёл (ход оборвался, движок забыл
           * инструмент), оставлял по себе запись — и его карточка тикала
           * секундомером вечно, а через час говорила «пульса нет 58 мин» о
           * законченном ходе. Это не наблюдение, а бормотание задним числом.
           */
          toolPulses: undefined,
          // Пометка «этот ход начала записка» живёт ровно один ход: следующий
          // может быть словами человека, и записывать его на чужой счёт нельзя.
          noteFrom: undefined,
          claudeSessionId: ev.sessionId ?? c.claudeSessionId,
          // Сколько стоил разговор. Движок считает это сам и до сих пор цифра
          // выбрасывалась; копим по БЕСЕДЕ, потому что «сколько стоило» человек
          // спрашивает про разговор, а не про приложение. Что именно означает
          // сумма на подписке — говорит подпись в баре: там она расчётная, а
          // не списанная.
          costUsd: addCost(c.costUsd, ev.costUsd),
          /*
           * БОКОВОЙ ВОПРОС ОТВЕЧЕН — возвращаем беседу туда, где она была.
           *
           * Следующий ход уйдёт веткой от точки ДО вопроса, то есть ни вопрос,
           * ни ответ на него в контекст не поедут. В ленте они остаются: они
           * были, человек их читал, и стирать их значило бы соврать иначе.
           *
           * `claudeSessionId` тоже возвращаем: точка `at` осмысленна только
           * внутри своей сессии, и разъехавшаяся пара увела бы ветку не туда.
           *
           * Сработает один раз — поле снимается здесь же. Иначе КАЖДЫЙ
           * следующий ход возвращался бы в ту же точку, и беседа перестала бы
           * накапливаться вовсе.
           */
          ...(c.sideBack
            ? {
                resumeAt: c.sideBack.at,
                claudeSessionId: c.sideBack.sessionId,
                sideBack: undefined,
                // Ветка отбросит боковую пару — занятое станет меньше, а нового
                // числа до следующего хода не будет. Старое соврало бы.
                context: undefined
              }
            : {})
          /*
           * Одной точки МАЛО — это показал живой прогон: агент помнил то, что
           * обещано было забыть. `resumeSessionAt`/`forkSession` читаются при
           * СПАВНЕ, а пока сессия жива, следующий ход просто дописывается в её
           * очередь, и опции возобновления не смотрит никто. Поэтому ниже мы
           * ещё и просим драйвер закрыть живую сессию — тогда следующий ход
           * поднимет её заново и уже веткой.
           */
          /*
           * Волна ОСТАЁТСЯ на экране. Раньше здесь стояло `subagents:
           * undefined` — «законченный счётчик выглядел бы как работа». Но
           * стирался с ним и след: после «18 из 18» не оставалось ничего о
           * том, кто что сделал и кто не смог, а упавшая задача исчезала
           * ровно в тот миг, когда о ней надо узнать.
           *
           * Настоящее возражение было к ВИДУ, а не к записи: теперь
           * законченная волна и выглядит законченной — без крутилки, со своим
           * знаком, и с отдельной строкой на каждую неудачу. Волну сбрасывает
           * начало СЛЕДУЮЩЕГО хода (см. send): так «3 из 7» всегда про один
           * ход, а не про два сложенных вместе.
           */
        }))
        /*
         * Просим драйвер закрыть живую сессию — вторая половина обещания.
         * Читаем состояние ДО патча выше: там `sideBack` уже снят, а знать надо
         * именно то, был ли этот ход боковым.
         */
        if (convBefore?.sideBack && convBefore.engine !== 'builtin') {
          window.zarya.agent.forkNext(convBefore.engine, convId)
        }
        // Correct the fuel readout to the model that actually ran this turn.
        // Only when a single model ran (subagents would add extra keys → keep config).
        const ran = ev.models ?? []
        if (isClaudeStatus && ran.length === 1) {
          const st = useUiStore.getState().claudeStatus
          // Don't clobber a model the user just switched TO mid-turn: the finished
          // turn ran the OLD model, but a live setModel already re-pinned the next
          // one. Only correct when the committed pin still matches what ran.
          // Version-aware: a family-only compare treated 'claude-opus-4-8' and
          // 'claude-opus-5' as the same pin, so a genuine generation switch was
          // indistinguishable from a mid-turn one. A floating alias ('opus[1m]')
          // still matches whatever it resolves to — that is not a switch.
          const pin = getSettings().ai.claudeModel
          const pinMatches = !pin || sameModel(pin, ran[0])
          if (pinMatches && st.model !== ran[0]) {
            useUiStore.getState().set({ claudeStatus: { ...st, model: ran[0] } })
          }
          // И у самой панели: поправка касается ТОГО хода, что закончился здесь.
          const paneId = get().conversations.find((c) => c.id === convId)?.sessionId
          if (pinMatches) setAgentStatusFor(paneId, { model: ran[0] })
        }
        // Flush a message queued while the agent was working (CLI-style).
        const queued = get().conversations.find((c) => c.id === convId)?.queued
        if (queued && get().conversations.find((c) => c.id === convId)?.pendingTools.length === 0) {
          patchConversation(convId, (c) => ({ ...c, queued: undefined }))
          void get().send(queued, { conversationId: convId })
        }
        break
      }

      /*
       * Строка движка: ход оборвался, модель отказала, хук вмешался. Кладём её в
       * ленту как есть — своих формулировок не изобретаем. До этого такой конец
       * не давал НИ ОДНОГО события, и «думающие» точки просто гасли: на экране
       * это неотличимо от зависания.
       */
      case 'notice':
        patchConversation(convId, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            { role: 'assistant', content: [{ type: 'notice', level: ev.level, text: ev.text }] }
          ]
        }))
        break

      /*
       * Сжатие контекста. Пока идёт — строка со спиннером у ленты; когда
       * закончилось — отметка с числами движка. Иначе агент внезапно «забывал»
       * разговор, и объяснения на экране не было.
       */
      case 'compact':
        if (ev.phase === 'running') {
          patchConversation(convId, (c) => ({ ...c, compacting: true }))
          break
        }
        patchConversation(convId, (c) => ({
          ...c,
          compacting: false,
          messages:
            ev.phase === 'failed'
              ? [
                  ...c.messages,
                  {
                    role: 'assistant',
                    content: [
                      { type: 'notice', level: 'warn', text: ev.error || t('feed.compactFailed') }
                    ]
                  }
                ]
              : mergeCompactMark(c.messages, ev)
        }))
        break

      /*
       * Движок начал беседу заново. Лента остаётся — это записи человека, и
       * терять их из-за чужой забывчивости нельзя. Меняем номер сессии (иначе
       * следующий ход попросит продолжить разговор, которого у движка нет) и
       * ставим черту: дальше агент отвечает, не помня, что было выше.
       */
      case 'reset':
        patchConversation(convId, (c) => ({
          ...c,
          claudeSessionId: ev.sessionId,
          // Отматывать больше некуда: прежней ветки у движка не осталось.
          resumeAt: undefined,
          /*
           * И ЗАПОЛНЕНИЕ КОНТЕКСТА — ТОЖЕ.
           *
           * Ход «забыл разговор» токенов не тратит: движок присылает нулевую
           * `usage`, свежего числа не приходит вовсе. Без сброса чип продолжал
           * бы показывать прежние проценты рядом с чертой «дальше агент не
           * помнит» — два соседних утверждения, из которых одно ложь.
           *
           * Пустое место честнее старой цифры: она появится снова после
           * первого же настоящего хода.
           */
          context: undefined,
          messages: [...c.messages, { role: 'assistant', content: [{ type: 'reset' }] }]
        }))
        break

      case 'error':
        patchConversation(convId, (c) => ({
          ...c,
          streaming: false,
          typed: undefined,
          typedTool: undefined,
          activeRequestId: undefined,
          pendingTools: [],
          toolPulses: undefined,
          error: ev.message,
          /*
           * Боковой вопрос, оборвавшийся ошибкой, всё равно возвращает беседу.
           *
           * Ревью поймало: здесь точка не применялась и не снималась, а
           * следующая отправка её затирала — вопрос и обрывок ответа тихо
           * оставались в контексте, пока пометка над ними обещала обратное.
           * Ход не удался, но сказанное уже сказано, и вернуться надо тем более.
           */
          ...(c.sideBack
            ? {
                resumeAt: c.sideBack.at,
                claudeSessionId: c.sideBack.sessionId,
                sideBack: undefined,
                context: undefined
              }
            : {})
        }))
        break
    }
  }

  /**
   * Отметка о сжатии — ОДНА на одно сжатие.
   *
   * Движок объявляет конец дважды: строкой состояния («compact_result:
   * success», без чисел) и границей («compact_boundary», с числами до и после).
   * Порядок между ними не обещан, и приход обоих подряд оставил бы в ленте две
   * черты об одном событии. Поэтому вторая не добавляется, а ДОПОЛНЯЕТ первую:
   * числа появляются, когда придут, и не пропадают, если следом придёт пустая.
   *
   * Слияние возможно, только пока отметка — самая последняя часть ленты. Как
   * только после неё появилось хоть что-то (а между двумя настоящими сжатиями
   * всегда есть ход агента), новое сжатие станет отдельной чертой.
   */
  function mergeCompactMark(
    messages: AiMessage[],
    ev: { before?: number; after?: number; auto?: boolean }
  ): AiMessage[] {
    const mark: AiContentPart = {
      type: 'compact',
      before: ev.before,
      after: ev.after,
      auto: ev.auto
    }
    const last = messages[messages.length - 1]
    const tail = last?.content[last.content.length - 1]
    if (last?.role === 'assistant' && tail?.type === 'compact') {
      const merged: AiContentPart = {
        type: 'compact',
        before: ev.before ?? tail.before,
        after: ev.after ?? tail.after,
        auto: ev.auto ?? tail.auto
      }
      return [
        ...messages.slice(0, -1),
        { ...last, content: [...last.content.slice(0, -1), merged] }
      ]
    }
    return [...messages, { role: 'assistant', content: [mark] }]
  }

  /** Enqueue a tool execution on the conversation's serial chain. */
  function enqueueTool(
    convId: string,
    tool: { id: string; name: string; input: unknown }
  ): Promise<void> {
    const prev = execChains.get(convId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(() => executeToolInner(convId, tool))
    execChains.set(convId, next)
    return next
  }

  async function executeToolInner(
    convId: string,
    tool: { id: string; name: string; input: unknown }
  ): Promise<void> {
    const epoch = currentEpoch(convId)
    let content: string
    let isError = false
    if (tool.name !== 'run_command') {
      content = t('ai.unknownTool', { name: tool.name })
      isError = true
    } else {
      const input = tool.input as { command?: string } | null
      const command = typeof input?.command === 'string' ? input.command : ''
      if (!command.trim()) {
        content = t('ai.emptyCmd')
        isError = true
      } else {
        const conv = get().conversations.find((c) => c.id === convId)
        const sessionId = conv?.sessionId || useSessionsStore.getState().activeSessionId()
        if (!sessionId) {
          content = t('ai.noSession')
          isError = true
        } else {
          content = await runCommandAndWait(sessionId, command)
        }
      }
    }
    // Conversation was aborted/deleted while the command ran — drop the result.
    if (currentEpoch(convId) !== epoch || !get().conversations.some((c) => c.id === convId)) return

    patchConversation(convId, (c) => ({
      ...c,
      pendingTools: c.pendingTools.filter((t) => t.id !== tool.id),
      messages: [
        ...c.messages,
        { role: 'user', content: [{ type: 'tool_result', toolUseId: tool.id, content, isError }] }
      ]
    }))
    maybeContinue(convId)
  }

  /**
   * The agentic-loop barrier: dispatch the next turn only once the current
   * turn's request has finished (streaming === false) AND every tool_use of the
   * last assistant turn has a tool_result. Called after each tool resolves and
   * after the stream's 'done'.
   */
  function maybeContinue(convId: string): void {
    const conv = get().conversations.find((c) => c.id === convId)
    if (!conv || conv.streaming) return
    if (!lastAssistantHasToolUse(conv.messages)) return
    if (unresolvedToolUseIds(conv.messages).length > 0) return
    void dispatchChat(convId)
  }

  function handleStreamEvent(requestId: string, ev: AiStreamEvent): void {
    const convId = requestConv.get(requestId)
    if (!convId) return

    switch (ev.type) {
      case 'start':
        break

      case 'text':
        patchConversation(convId, (c) => appendText(c, ev.text))
        break

      case 'tool_use': {
        patchConversation(convId, (c) => appendToolUse(c, ev.id, ev.name, ev.input))
        noteSkills(convId, [{ name: ev.name, input: ev.input }])
        notePlanUse(convId, [{ toolUseId: ev.id, name: ev.name, input: ev.input }])
        /*
         * Пол над автоодобрением встроенного агента: необратимое спрашивают
         * всегда, даже когда «без подтверждений» включено. Плюс правила «до
         * конца сессии» — то, что человек уже разрешал сам.
         */
        const stop = irreversible(ev.name, ev.input)
        const convNow = get().conversations.find((c) => c.id === convId)
        const allowed = matchesRule(convNow?.sessionAllows, ev.name, ev.input)
        const auto =
          ev.name === 'run_command' ? !stop && (allowed || getSettings().ai.autoApprove) : true
        // Queue the tool; parallel tool_use blocks each get their own card.
        patchConversation(convId, (c) => ({
          ...c,
          pendingTools: [
            ...c.pendingTools.filter((t) => t.id !== ev.id),
            {
              id: ev.id,
              name: ev.name,
              input: ev.input,
              autoApproved: auto,
              settled: auto,
              irreversible: stop ?? undefined,
              // Автоодобренный инструмент никого не ждёт — время ставим только
              // тому, кто действительно встал перед человеком.
              askedAt: auto ? undefined : Date.now()
            }
          ]
        }))
        if (auto) void enqueueTool(convId, { id: ev.id, name: ev.name, input: ev.input })
        break
      }

      case 'done':
        requestConv.delete(requestId)
        patchConversation(convId, (c) =>
          c.activeRequestId === requestId
            ? {
                ...c,
                streaming: false,
                typed: undefined,
                typedTool: undefined,
                activeRequestId: undefined
              }
            : c
        )
        // If the finished turn contained tool calls that are already all
        // resolved (fast auto-approve path), continue the loop now.
        maybeContinue(convId)
        break

      case 'error':
        requestConv.delete(requestId)
        patchConversation(convId, (c) => ({
          ...c,
          streaming: false,
          typed: undefined,
          typedTool: undefined,
          activeRequestId: undefined,
          pendingTools: [],
          toolPulses: undefined,
          error: ev.message
        }))
        break
    }
  }

  window.zarya.ai.onStream(handleStreamEvent)
  window.zarya.agent.onStream(handleAgentEvent)

  return {
    conversations: [],
    activeId: null,
    activeBySession: {},
    commandBarSessionId: null,
    bypassBySession: {},
    editsAutoBySession: {},
    planBySession: {},
    shellTailOffBySession: {},
    pendingImages: {},

    hydrate: async () => {
      const saved = await window.zarya.aiConversations.load()
      hydrated = true
      // Restore ambient Claude state first (independent of conversations) so the
      // fuel gauge and launch pad — incl. the Fable-bearing catalog — are
      // populated on cold start even before any session init or if no
      // conversation had messages worth persisting.
      if (saved?.claudeStatus) useUiStore.getState().set({ claudeStatus: saved.claudeStatus })
      if (saved?.claudeModels?.length)
        useUiStore.getState().set({ claudeModels: saved.claudeModels })
      if (!saved?.conversations?.length) return
      const conversations: Conversation[] = saved.conversations.map((p) => ({
        id: p.id,
        title: p.title,
        messages: p.messages,
        sessionId: p.sessionId,
        engine: p.engine,
        claudeSessionId: p.claudeSessionId,
        resumeAt: p.resumeAt,
        interrupted: p.interrupted,
        /*
         * Отказ отдавать консоль поднимается с диска ОБЯЗАТЕЛЬНО.
         *
         * Ревью поймало ровно этот пропуск: флаг писался, но не читался, и
         * после перезапуска подача возвращалась молча — а плашка показывала
         * кнопку «не читать здесь», то есть человек и узнать бы не смог. Хуже
         * несделанной фичи только фича, которая сама себя отменяет.
         */
        shellTailOff: p.shellTailOff,
        // Точка возврата бокового вопроса — иначе перезапуск посреди хода
        // оставил бы вопрос в контексте под пометкой «не поедет».
        sideBack: p.sideBack,
        cwd: p.cwd,
        // Any non-builtin engine drives its own agentic tool loop. A conv written
        // by a newer build with an unknown engine still lands here as an agent
        // conv (graceful) rather than crashing hydrate.
        agentMode: p.engine !== 'builtin',
        streaming: false,
        pendingTools: [],
        toolStartedAt: {},
        pendingContext: [],
        createdAt: p.createdAt
      }))
      /*
       * Карта отказов восстанавливается из поднятых бесед.
       *
       * Иначе перезапуск чинил бы старые разговоры и ломал новые: беседа со
       * своим флагом консоль не отдаёт, а первая же новая в той же панели —
       * отдаёт, потому что карта пуста. Отказ бы «наполовину пережил»
       * перезапуск, и объяснить человеку эту половину было бы нечем.
       */
      const shellTailOffBySession: Record<string, boolean> = {}
      for (const c of conversations) {
        if (c.sessionId && c.shellTailOff) shellTailOffBySession[c.sessionId] = true
      }
      set({
        conversations,
        activeBySession: saved.activeBySession ?? {},
        shellTailOffBySession,
        activeId: conversations[conversations.length - 1]?.id ?? null
      })
    },

    saveNow: async () => {
      await persistConversations(get())
    },

    newConversation: (opts) => {
      const id = uid('conv')
      const cwd = opts?.sessionId
        ? useSessionsStore.getState().sessions[opts.sessionId]?.cwd
        : undefined
      const conv: Conversation = {
        id,
        title: opts?.title ?? t('ai.newConv'),
        messages: [],
        sessionId: opts?.sessionId,
        engine: opts?.engine ?? 'builtin',
        cwd,
        // A native agent engine drives its own agentic tool loop — agent mode implicit.
        agentMode: (opts?.engine ?? 'builtin') !== 'builtin',
        // Автопилот — из намерения ЭТОЙ панели, а не из настроек и не от соседа.
        bypass: opts?.sessionId ? get().bypassBySession[opts.sessionId] : undefined,
        editsAuto: opts?.sessionId ? get().editsAutoBySession[opts.sessionId] : undefined,
        // Режим плана — оттуда же и по той же причине. Без этого чип горел бы,
        // а первый же ход уходил бы обычным: человек видел бы обещание
        // осторожности, которого никто не давал драйверу.
        planMode: opts?.sessionId ? get().planBySession[opts.sessionId] : undefined,
        // Отказ отдавать консоль — тоже намерение ПАНЕЛИ: человек сказал «не
        // читать здесь» про своё окно терминала, а не про один разговор в нём.
        shellTailOff: opts?.sessionId ? get().shellTailOffBySession[opts.sessionId] : undefined,
        streaming: false,
        pendingTools: [],
        toolStartedAt: {},
        pendingContext: [],
        createdAt: Date.now()
      }
      set((s) => ({
        conversations: [...s.conversations, conv],
        activeId: id,
        activeBySession: opts?.sessionId
          ? { ...s.activeBySession, [opts.sessionId]: id }
          : s.activeBySession
      }))
      return id
    },

    setActiveConversation: (id) => {
      if (get().conversations.some((c) => c.id === id)) set({ activeId: id })
    },

    deleteConversation: (id) => {
      bumpEpoch(id)
      execChains.delete(id)
      set((s) => {
        const conv = s.conversations.find((c) => c.id === id)
        if (conv?.activeRequestId) {
          window.zarya.ai.abort(conv.activeRequestId)
          requestConv.delete(conv.activeRequestId)
        }
        const conversations = s.conversations.filter((c) => c.id !== id)
        const activeId =
          s.activeId === id ? (conversations[conversations.length - 1]?.id ?? null) : s.activeId
        return { conversations, activeId }
      })
      /*
       * Панель закрыли — состав обязан уехать НЕМЕДЛЕННО. Иначе агент соседней
       * панели увидит в списке закрытую и напишет ей: доставка окажется в
       * никуда, а он услышит «доставлено». Сохранение сюда не звали вовсе, и
       * реестр устаревал молча.
       */
      scheduleSave()
    },

    activeConversation: () => {
      const s = get()
      return s.conversations.find((c) => c.id === s.activeId)
    },

    send: async (text, opts) => {
      const conv = resolveConv(opts?.conversationId)
      // Block a new message while streaming OR while any tool call from the
      // current turn is still unresolved — sending now would append a user
      // message between an assistant tool_use and its tool_result, which the
      // provider rejects and which corrupts the conversation permanently.
      if (!conv || isConversationBusy(conv)) return
      const trimmed = text.trim()
      // Вложения берём у ПАНЕЛИ этой беседы: вставляли их туда, где стоял курсор.
      const images = (conv.sessionId ? get().pendingImages[conv.sessionId] : undefined) ?? []
      // Сообщение из одних картинок — законное: «что тут не так?» со скриншотом.
      if (!trimmed && !conv.pendingContext.length && !images.length) return

      /*
       * Записка соседней панели идёт ОДНОЙ частью своего вида. Ни контекста, ни
       * картинок к ней не цепляем: это чужая записка, а вложения — то, что
       * человек положил в СВОЮ строку ввода.
       */
      if (opts?.paneNote) {
        patchConversation(conv.id, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              role: 'user' as const,
              content: [{ type: 'pane-note' as const, from: opts.paneNote!.from, text: trimmed }],
              ts: Date.now()
            }
          ],
          /*
           * ЧЕЙ ЭТО ХОД — запоминаем до его конца.
           *
           * Стоимость движок называет в конце, и к тому времени о том, что ход
           * начала чужая записка, знать уже неоткуда. Без этой пометки
           * денежный предохранитель считал бы работу человека тоже — и гасил
           * бы переписку за то, чего она не тратила.
           */
          noteFrom: opts.paneNote!.fromConvId || undefined,
          error: undefined
        }))
        /*
         * Панель показывает АКТИВНУЮ беседу. Записка, пришедшая в неактивную,
         * оставалась невидимой: агент на неё отвечает, а человек не видит ни
         * записки, ни ответа. Тот же перевод фокуса делает обычная отправка.
         */
        if (conv.sessionId) {
          const sid = conv.sessionId
          set((s) => ({
            activeBySession: { ...s.activeBySession, [sid]: conv.id },
            activeId: conv.id
          }))
        }
        if (conv.engine !== 'builtin') dispatchAgent(conv.id)
        else await dispatchChat(conv.id)
        return
      }

      const parts: AiContentPart[] = conv.pendingContext.map((ctx) => ({
        type: 'text',
        text: `[Контекст: ${ctx.label}]\n${ctx.content}`
      }))
      /*
       * ХВОСТ КОНСОЛИ — между чужим контекстом и словами человека.
       *
       * Порядок не случаен: последним в ходе идёт то, что человек написал сам.
       * Так же устроена и приписка к системному промпту — при споре двух
       * указаний ближе к концу должно быть его слово, а не наша заготовка.
       *
       * Собираем ЗДЕСЬ, а не в момент отправки движку: хвост обязан описывать
       * консоль на момент этого хода. Пересобранный позже, он показал бы под
       * старым вопросом сегодняшние команды.
       */
      const tail = collectShellTail(conv)
      if (tail) {
        parts.push({
          type: 'shell-tail',
          text: tail.text,
          used: tail.used,
          ...(tail.dropped ? { dropped: tail.dropped } : {})
        })
      }
      // Плейсхолдер в тексте, блоки следом и в том же порядке — так это делает
      // настоящий CLI: модель видит ссылку на картинку там, где её вставили.
      const marks = images.map((_, i) => imagePlaceholder(i)).join(' ')
      const headText = [marks, trimmed].filter(Boolean).join(' ')
      if (headText) parts.push({ type: 'text', text: headText })
      for (const img of images) {
        parts.push({
          type: 'image',
          mediaType: img.mediaType,
          data: img.data,
          bytes: img.bytes,
          width: img.width,
          height: img.height,
          name: img.name
        })
      }
      if (conv.sessionId && images.length) get().clearImages(conv.sessionId)

      /*
       * БОКОВОЙ ВОПРОС: снимаем точку ДО отправки.
       *
       * Позже её взять неоткуда: «последняя точка» после ответа — это и есть
       * ответ на боковой вопрос. Спрашиваем движок здесь, ничего не прерывая.
       *
       * Точки может не быть законно: первый ход в свежей сессии (агент ещё не
       * отвечал, возвращаться некуда) или движок без форка. Тогда обещание
       * «мимо контекста» не сбудется, и пометка в ленте скажет это прямо —
       * молча выдать обычный ход за боковой было бы худшим исходом.
       */
      let sideBack: { sessionId: string; at: string } | undefined
      if (opts?.side && conv.engine !== 'builtin') {
        /*
         * УЖЕ СТОЯЩАЯ ТОЧКА ВАЖНЕЕ СВЕЖЕЙ.
         *
         * Ревью поймало: на втором боковом вопросе подряд движок отдаёт точку
         * ПОСЛЕ первой боковой пары — и первая пара тихо оставалась в контексте,
         * пока пометка над ней обещала «дальше не поедет». То же и после отмены
         * отправленного: там точка тоже уже выставлена, и возвращаться надо
         * туда же, а не в место, куда беседу успело унести.
         *
         * Правило одно: если беседа уже помнит, куда возвращаться, — держимся
         * этого. Спрашиваем движок только когда возвращаться пока некуда.
         */
        const held =
          conv.resumeAt && conv.claudeSessionId
            ? { sessionId: conv.claudeSessionId, at: conv.resumeAt }
            : undefined
        if (held) sideBack = held
        else {
          const point = await window.zarya.agent.forkPoint(conv.engine, conv.id).catch(() => null)
          if (point?.kind === 'fork') sideBack = { sessionId: point.sessionId, at: point.at }
        }
      }
      if (opts?.side) parts.push({ type: 'side-mark', kept: !!sideBack })

      patchConversation(conv.id, (c) => ({
        ...c,
        messages: [...c.messages, { role: 'user', content: parts, ts: Date.now() }],
        pendingContext: [],
        error: undefined,
        /*
         * Куда вернуться после ответа. Держим в беседе, а не в замыкании: ход
         * может кончиться перезапуском или отменой, и «висящая» переменная в
         * этих случаях молча потеряла бы обещание.
         */
        sideBack,
        title:
          c.messages.length === 0 && c.title === t('ai.newConv')
            ? deriveTitle(trimmed || conv.pendingContext[0]?.label || '')
            : c.title
      }))
      // Keep this the active conversation for its terminal (feed follows it).
      if (conv.sessionId) {
        const sid = conv.sessionId
        set((s) => ({
          activeBySession: { ...s.activeBySession, [sid]: conv.id },
          activeId: conv.id
        }))
      }
      if (conv.engine !== 'builtin') dispatchAgent(conv.id)
      else await dispatchChat(conv.id)
    },

    abort: (conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      // Cancel the request (if any) and stop the agentic loop: drop pending
      // tools and bump the epoch so an in-flight command's late result is
      // discarded rather than re-triggering the loop.
      bumpEpoch(conv.id)
      execChains.delete(conv.id)
      if (conv.engine !== 'builtin') {
        window.zarya.agent.interrupt(conv.engine, conv.id)
      } else if (conv.activeRequestId) {
        window.zarya.ai.abort(conv.activeRequestId)
        requestConv.delete(conv.activeRequestId)
      }
      // Mark the turn that was cut off. It stays in the transcript — and stays
      // in the agent's context on resume — so leaving it indistinguishable from
      // an answered turn is what made «я отменил, но он всё равно это видел»
      // surprising.
      // tool_result хранится тем же role:'user' и в ленте невидим — пометка на
      // нём просто не рисуется. Ищем последний ход, который лента реально
      // показывает (условие зеркалит MissionFeed).
      const isVisibleUserTurn = (m: AiMessage): boolean =>
        m.role === 'user' &&
        m.content.some(
          (p) =>
            // Записка соседней панели — такой же ход: агент её обрабатывает, и
            // пометка «прервано» должна лечь на неё, а не на предыдущий ход.
            p.type === 'pane-note' ||
            (p.type === 'text' && !p.text.startsWith('[Контекст:') && !!p.text.trim())
        )
      // Помечать есть что, только если ход и правда шёл. Esc по уже законченной
      // беседе прерывать нечего — а метку бы поставил: второй Esc сразу после
      // отмены отправленного (первый ещё летит по IPC) вешал «прервано» на
      // ПРЕДЫДУЩИЙ, честно отвеченный ход.
      const wasRunning = conv.streaming || conv.pendingTools.length > 0
      let lastUser = -1
      for (let i = conv.messages.length - 1; wasRunning && i >= 0; i--) {
        if (isVisibleUserTurn(conv.messages[i])) {
          lastUser = i
          break
        }
      }
      patchConversation(conv.id, (c) => ({
        ...c,
        streaming: false,
        typed: undefined,
        typedTool: undefined,
        activeRequestId: undefined,
        pendingTools: [],
        toolPulses: undefined,
        interrupted:
          lastUser >= 0 && !(c.interrupted ?? []).includes(lastUser)
            ? [...(c.interrupted ?? []), lastUser]
            : c.interrupted
      }))
    },

    undoSend: async (conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv || conv.engine === 'builtin') return null
      // Отменяем только то, на что агент ещё НЕ ответил. Если он успел что-то
      // сказать, удаление хода стёрло бы и его слова — так не делает и CLI: там
      // в этом случае остаётся пометка о прерывании.
      const last = conv.messages[conv.messages.length - 1]
      const text = (last?.role === 'user' ? last.content : [])
        .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .filter((t) => !t.startsWith('[Контекст:'))
        .join('\n')
        .trim()
      if (!text) return null
      // Спрашиваем ДРАЙВЕР, умеет ли он убрать это из памяти агента. Убрать из
      // ленты то, что агент всё равно помнит, — ровно то враньё, из-за которого
      // «я же отменил» и оказывалось неправдой.
      const rewind = await window.zarya.agent.rewind(conv.engine, conv.id)
      if (!rewind) return null
      // За время запроса агент мог заговорить. Тогда последним стоит уже ЕГО
      // сообщение, и слепое «убрать последнее» стёрло бы ответ вместо вопроса.
      // Отступаем: ход всё равно прерван, лента честно скажет «прервано».
      const fresh = get().conversations.find((c) => c.id === conv.id)
      if (!fresh || fresh.messages[fresh.messages.length - 1] !== last) return null
      bumpEpoch(conv.id)
      execChains.delete(conv.id)
      patchConversation(conv.id, (c) => ({
        ...c,
        messages: c.messages.slice(0, -1),
        streaming: false,
        typed: undefined,
        typedTool: undefined,
        activeRequestId: undefined,
        pendingTools: [],
        toolPulses: undefined,
        subagents: undefined,
        // Куда продолжать. 'fork' — веткой от последнего ответа агента;
        // 'fresh' — отматывать не к чему, и следующий ход начнёт сессию с нуля,
        // поэтому прежний id надо забыть: возобновление втащило бы отменённое
        // обратно. Оба поля переживают перезапуск (см. PersistedConversation).
        claudeSessionId: rewind.kind === 'fork' ? rewind.sessionId : undefined,
        resumeAt: rewind.kind === 'fork' ? rewind.at : undefined,
        // Отменённый ход уходит из контекста — значит и число про него больше
        // не про этот разговор. Появится снова после следующего хода.
        context: undefined,
        // Пометка «прервано» указывает на индексы ходов; после удаления
        // последнего она бы поехала. Ход исчез — помечать нечего.
        interrupted: (c.interrupted ?? []).filter((i) => i < c.messages.length - 1)
      }))
      return text
    },

    attachImage: (sessionId, att) => {
      set((s) => ({
        pendingImages: {
          ...s.pendingImages,
          [sessionId]: [...(s.pendingImages[sessionId] ?? []), att]
        }
      }))
    },

    dropImage: (sessionId, id) => {
      set((s) => ({
        pendingImages: {
          ...s.pendingImages,
          [sessionId]: (s.pendingImages[sessionId] ?? []).filter((a) => a.id !== id)
        }
      }))
    },

    clearImages: (sessionId) => {
      set((s) => {
        if (!s.pendingImages[sessionId]?.length) return {}
        const next = { ...s.pendingImages }
        delete next[sessionId]
        return { pendingImages: next }
      })
    },

    forgetSession: (sessionId) => {
      // ВСЕ беседы панели, а не только последняя: чип «недавние сессии» заводит
      // вторую, и первая с висящим гейтом иначе оставалась бы «ждущей» навсегда.
      for (const conv of get().conversations.filter((c) => c.sessionId === sessionId)) {
        // Сперва глушим ход: abort бампает epoch и чистит цепочку инструментов,
        // поэтому поздний ответ уже никуда не поедет. Безусловно, а не «если
        // streaming»: снимок мог устареть между решением и этим вызовом.
        get().abort(conv.id)
        const unsettled = conv.pendingTools.filter((t) => !t.settled)
        if (!unsettled.length) continue
        if (conv.engine !== 'builtin') {
          // Нативному движку отказ отправить НАДО: без ответа драйвер остаётся
          // висеть на своём вопросе.
          for (const t of unsettled) get().denyTool(conv.id, t.id)
          continue
        }
        // Свой агент: гейты гасим МОЛЧА. denyTool здесь по контракту продолжает
        // диалог (maybeContinue) — то есть закрытие панели отправляло бы новый
        // платный запрос за агента, которого человек только что закрыл.
        patchConversation(conv.id, (c) => ({
          ...c,
          pendingTools: c.pendingTools.filter((t) => !unsettled.some((u) => u.id === t.id))
        }))
      }
      set((s) => {
        const images = { ...s.pendingImages }
        const bypass = { ...s.bypassBySession }
        delete images[sessionId]
        delete bypass[sessionId]
        return { pendingImages: images, bypassBySession: bypass }
      })
    },

    /** «Правки без спроса» панели — по той же схеме, что автопилот и план. */
    setPaneEditsAuto: (sessionId, on) => {
      set((s) => ({ editsAutoBySession: { ...s.editsAutoBySession, [sessionId]: on } }))
      const conv = convForSession(get(), sessionId)
      if (conv) get().setEditsAuto(conv.id, on)
    },

    setPaneBypass: (sessionId, on) => {
      set((s) => ({ bypassBySession: { ...s.bypassBySession, [sessionId]: on } }))
      // Если беседа в этой панели уже есть — применить и к ней.
      const conv = convForSession(get(), sessionId)
      if (conv) get().setBypass(conv.id, on)
    },

    /**
     * Режим плана панели. Запоминается за панелью, как и автопилот: чип не
     * должен быть мёртвым до первого сообщения.
     */
    setPanePlanMode: (sessionId, on) => {
      set((s) => ({ planBySession: { ...s.planBySession, [sessionId]: on } }))
      const conv = convForSession(get(), sessionId)
      if (conv) get().setPlanMode(conv.id, on)
    },

    setPlanMode: (conversationId, on) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({
        ...c,
        planMode: on,
        // «Не выполняй ничего» и «выполняй без спроса» вместе не значат ничего.
        // Включая план, снимаем автопилот — и на экране это видно сразу, а не
        // выясняется на первом же вызове инструмента.
        ...(on ? { bypass: false } : {})
      }))
      if (on && conv.bypass) get().setBypass(conv.id, false)
      if (conv.sessionId)
        set((s) => ({ planBySession: { ...s.planBySession, [conv.sessionId as string]: on } }))
      // Живой сессии — сразу: движок умеет менять режим на ходу, и ждать
      // следующего хода незачем.
      if (conv.engine !== 'builtin')
        void window.zarya.agent.setPermissionMode(conv.engine, conv.id, on ? 'plan' : 'default')
    },

    setShellTailOff: (conversationId, off) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({ ...c, shellTailOff: off }))
      /*
       * Запомнить за ПАНЕЛЬЮ — так написано в подписи кнопки. Без этого
       * следующий разговор в том же окне снова забирал бы консоль, о которой
       * человек уже сказал «не читать».
       *
       * Помечаем и УЖЕ ОТКРЫТЫЕ беседы этой панели: человек видит одно окно и
       * решение принимает про него, а не про ту из вкладок разговора, что
       * оказалась активной в момент нажатия.
       */
      if (conv.sessionId) {
        const sid = conv.sessionId
        set((s) => ({
          shellTailOffBySession: { ...s.shellTailOffBySession, [sid]: off },
          conversations: s.conversations.map((c) =>
            c.sessionId === sid ? { ...c, shellTailOff: off } : c
          )
        }))
        scheduleSave()
      }
    },

    setEditsAuto: (conversationId, on) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({ ...c, editsAuto: on }))
      if (conv.sessionId)
        set((s) => ({
          editsAutoBySession: { ...s.editsAutoBySession, [conv.sessionId as string]: on }
        }))
      // Живой сессии — сразу: карточки правок сыплются ВНУТРИ хода, и ждать
      // следующего сообщения незачем.
      if (conv.engine !== 'builtin')
        window.zarya.agent.setVendorFlag(conv.engine, conv.id, 'editsAuto', on)
    },

    setBypass: (conversationId, on) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({ ...c, bypass: on }))
      // Запомнить за панелью: следующая беседа в ней откроется с тем же выбором,
      // а соседних панелей это не касается.
      if (conv.sessionId)
        set((s) => ({ bypassBySession: { ...s.bypassBySession, [conv.sessionId as string]: on } }))
      // Живой сессии — сразу: следующий инструмент не должен ждать нового хода.
      if (conv.engine !== 'builtin') window.zarya.agent.setBypass(conv.engine, conv.id, on)
    },

    allowForSession: async (conversationId, toolId) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      const tool = conv?.pendingTools.find((t) => t.id === toolId)
      if (!conv || !tool) return
      const rule = ruleFor(tool.name, tool.input)
      // Необратимому правила не выдаются вообще — кнопка для него и не
      // показывается, но проверка стоит и здесь: путь к действию не один.
      if (!rule) return
      patchConversation(conversationId, (c) => ({
        ...c,
        sessionAllows: withRule(c.sessionAllows, rule)
      }))
      await get().approveTool(conversationId, toolId)
    },

    revokeSessionRule: (conversationId, rule) => {
      patchConversation(conversationId, (c) => ({
        ...c,
        sessionAllows: (c.sessionAllows ?? []).filter((r) => r !== rule)
      }))
    },

    /*
     * ПУСТИТЬ АГЕНТА В ЕЩЁ ОДНУ ПАПКУ.
     *
     * Папки — опция запуска движка, а живая сессия переживает все ходы беседы:
     * поменять её на лету нечем. Драйвер закрывает сессию, и следующий ход
     * поднимает её заново — с новой папкой и тем же контекстом (`resume`).
     *
     * Поэтому только когда ход НЕ идёт. Оборвать работу ради расширения
     * доступа — обменять сделанное на удобство, о котором никто не просил.
     */
    addWorkDir: async (conversationId) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv || conv.engine === 'builtin') return { ok: false, reason: 'no-engine' }
      if (isConversationBusy(conv)) return { ok: false, reason: 'busy' }
      const dir = await window.zarya.app.pickDirectory()
      if (!dir) return { ok: false, reason: 'canceled' }
      // Проверяем ЗАНОВО: диалог ОС держали открытым, и за это время агент мог
      // начать работу — решение принималось про другое состояние.
      const now = get().conversations.find((c) => c.id === conversationId)
      if (!now || now.engine === 'builtin') return { ok: false, reason: 'no-engine' }
      if (isConversationBusy(now)) return { ok: false, reason: 'busy' }
      if ((now.extraDirs ?? []).includes(dir) || now.cwd === dir)
        return { ok: false, dir, reason: 'already' }
      patchConversation(conversationId, (c) => ({
        ...c,
        extraDirs: [...(c.extraDirs ?? []), dir]
      }))
      /*
       * Ответ драйвера читаем, а не выбрасываем.
       *
       * У драйвера своя, последняя проверка занятости, и между нашей и его
       * успевает начаться ход. Оставить папку в списке после его отказа значило
       * бы показать выданное разрешение, которого движок не получил, — и сказать
       * «со следующего хода не спросят» там, где спросят.
       */
      const applied = await window.zarya.agent.applyDirs(now.engine, conversationId)
      if (!applied?.ok) {
        patchConversation(conversationId, (c) => ({
          ...c,
          extraDirs: (c.extraDirs ?? []).filter((d) => d !== dir)
        }))
        return { ok: false, dir, reason: applied?.reason === 'busy' ? 'busy' : 'no-engine' }
      }
      return { ok: true, dir }
    },

    removeWorkDir: async (conversationId, dir) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv || conv.engine === 'builtin') return
      patchConversation(conversationId, (c) => ({
        ...c,
        extraDirs: (c.extraDirs ?? []).filter((d) => d !== dir)
      }))
      /*
       * Отзыв не ждёт покоя, в отличие от выдачи: забрать лишнее разрешение
       * хотят немедленно, и заставлять ждать конца хода здесь неправильно.
       *
       * Но и ОБОРВАТЬ ход ради этого нельзя. Живой сессии состав папок задан при
       * запуске, и снять его можно только закрыв её — то есть убив работу,
       * которую человек не просил убивать. Поэтому пока ход идёт, драйвера не
       * трогаем: из списка папка ушла, а движок доработает с ней и потеряет её
       * со следующего хода. Ровно это и написано в подсказке кнопки.
       */
      if (isConversationBusy(conv)) {
        /*
         * Помечаем расхождение, а не забываем о нём.
         *
         * Живая сессия переживает ВСЕ ходы беседы: состав папок задан ей один
         * раз при запуске, и следующий ход просто дописывается в ту же очередь.
         * Без этой пометки отозванная папка оставалась бы «своей» для движка до
         * конца разговора, а панель показывала бы, что доступа нет. Применим,
         * как только беседа освободится (см. `case 'result'`).
         */
        patchConversation(conversationId, (c) => ({ ...c, dirsDirty: true }))
        return
      }
      await window.zarya.agent.applyDirs(conv.engine, conversationId)
    },

    approveTool: async (conversationId, toolId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      const tool = toolId
        ? conv.pendingTools.find((t) => t.id === toolId)
        : conv.pendingTools.find((t) => !t.settled)
      if (!tool || tool.settled) return
      // Native agent: the driver owns execution — just resolve the permission gate.
      // Mark settled (hide buttons); the tool_result event removes it later.
      if (conv.engine !== 'builtin') {
        patchConversation(conv.id, (c) => ({
          ...c,
          pendingTools: c.pendingTools.map((t) => (t.id === tool.id ? { ...t, settled: true } : t)),
          toolStartedAt: { ...c.toolStartedAt, [tool.id]: Date.now() }
        }))
        // `always` передаётся ровно тогда, когда у гейта нет разового варианта —
        // и тогда кнопка, которую нажали, называлась «РАЗРЕШИТЬ ВСЕГДА». Без
        // этого флага драйвер откажется выбирать постоянное разрешение и ответит
        // «отменено»: молча повысить разовое одобрение до сессионного нельзя.
        window.zarya.agent.permission(conv.engine, conv.id, tool.id, {
          behavior: 'allow',
          always: tool.allowAlwaysOnly === true
        })
        /*
         * План принят — режим плана кончился.
         *
         * Без этого согласие «переходи к работе» ничего бы не меняло: агент
         * остался бы связанным, и каждая правка упиралась бы в отказ. Человек
         * нажал бы «выполнить» и получил бы агента, который по-прежнему только
         * рассказывает — интерфейс пообещал бы действие и не дал его.
         *
         * Снимаем ЗДЕСЬ, а не по слову движка: сигнала «режим сменился» в
         * протоколе нет, а решение уже принято — вот оно, в этом нажатии.
         */
        if (tool.name === 'ExitPlanMode' && conv.planMode) {
          get().setPlanMode(conv.id, false)
          useUiStore.getState().toast(t('bar.planDone'), 'success')
        }
        return
      }
      patchConversation(conv.id, (c) => ({
        ...c,
        pendingTools: c.pendingTools.map((t) => (t.id === tool.id ? { ...t, settled: true } : t)),
        toolStartedAt: { ...c.toolStartedAt, [tool.id]: Date.now() }
      }))
      await enqueueTool(conv.id, { id: tool.id, name: tool.name, input: tool.input })
    },

    denyTool: (conversationId, toolId, reason) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      const tool = toolId
        ? conv.pendingTools.find((t) => t.id === toolId)
        : conv.pendingTools.find((t) => !t.settled)
      if (!tool || tool.settled) return
      // Native agent: resolve the gate as denied; the driver emits the tool_result.
      if (conv.engine !== 'builtin') {
        patchConversation(conv.id, (c) => ({
          ...c,
          pendingTools: c.pendingTools.filter((t) => t.id !== tool.id)
        }))
        window.zarya.agent.permission(conv.engine, conv.id, tool.id, {
          behavior: 'deny',
          // Слова человека — дословно. Своей формулировкой отказ снабжаем только
          // тогда, когда сказать было нечего.
          message: reason?.trim() || t('ai.denied')
        })
        return
      }
      patchConversation(conv.id, (c) => ({
        ...c,
        pendingTools: c.pendingTools.filter((t) => t.id !== tool.id),
        messages: [
          ...c.messages,
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolUseId: tool.id,
                content: reason?.trim() || t('ai.denied'),
                isError: true
              }
            ]
          }
        ]
      }))
      maybeContinue(conv.id)
    },

    queueMessage: (conversationId, text) => {
      const t = text.trim()
      if (!t) return
      patchConversation(conversationId, (c) => ({
        ...c,
        queued: c.queued ? `${c.queued}\n${t}` : t
      }))
    },

    takeQueued: (conversationId) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      const q = conv?.queued
      if (q) patchConversation(conversationId, (c) => ({ ...c, queued: undefined }))
      return q
    },

    resumeClaudeSession: (opts) => {
      const sid = opts.sessionId ?? useSessionsStore.getState().activeSessionId() ?? undefined
      const id = uid('conv')
      const conv: Conversation = {
        id,
        title: opts.title || t('ai.claudeSession'),
        messages: opts.messages,
        sessionId: sid,
        engine: 'claude-code',
        claudeSessionId: opts.claudeSessionId,
        cwd: opts.cwd,
        agentMode: true,
        streaming: false,
        pendingTools: [],
        toolStartedAt: {},
        pendingContext: [],
        createdAt: Date.now()
      }
      set((s) => ({
        conversations: [...s.conversations, conv],
        activeId: id,
        activeBySession: sid ? { ...s.activeBySession, [sid]: id } : s.activeBySession
      }))
      return id
    },

    answerQuestion: (conversationId, toolId, answers) => {
      const conv = get().conversations.find((c) => c.id === conversationId)
      const tool = conv?.pendingTools.find((t) => t.id === toolId)
      if (!conv || !tool || tool.settled) return
      // Mark settled + resume streaming; the SDK continues once it receives the
      // answer. Echo the choice into the transcript as a synthetic user turn so
      // the feed shows what was picked.
      const chosen = Object.values(answers).flat().join(', ')
      patchConversation(conv.id, (c) => ({
        ...c,
        streaming: true,
        pendingTools: c.pendingTools.filter((t) => t.id !== toolId),
        messages: chosen
          ? [...c.messages, { role: 'user', content: [{ type: 'text', text: `➤ ${chosen}` }] }]
          : c.messages
      }))
      // Generic structured-answer path; the driver maps {answers} to its wire.
      if (conv.engine !== 'builtin') {
        window.zarya.agent.question(conv.engine, conv.id, toolId, { answers })
      }
    },

    attachBlockContext: (block, conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      const label = t('ai.ctxBlock', { cmd: truncateText(block.command || t('ai.cmdWord'), 34) })
      const status =
        block.exitCode === undefined
          ? t('ai.running')
          : block.exitCode === 0
            ? t('ai.ok')
            : t('ai.exitCode', { code: block.exitCode })
      const content = [
        `$ ${block.command || t('ai.unknownCmd')}`,
        `cwd: ${block.cwd || '—'}`,
        t('ai.statusLine', { status }),
        '',
        tailClip(block.output, CONTEXT_BLOCK_OUTPUT_CAP)
      ].join('\n')
      get().attachContext(label, content, conv.id)
    },

    attachContext: (label, content, conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      const ctx: AiContextChip = { id: uid('ctx'), label, content }
      patchConversation(conv.id, (c) => ({ ...c, pendingContext: [...c.pendingContext, ctx] }))
    },

    removeContext: (contextId, conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({
        ...c,
        pendingContext: c.pendingContext.filter((x) => x.id !== contextId)
      }))
    },

    dismissError: (conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({ ...c, error: undefined }))
    },

    setAgentMode: (on, conversationId) => {
      const conv = resolveConv(conversationId)
      if (!conv) return
      patchConversation(conv.id, (c) => ({ ...c, agentMode: on }))
    }
  }
})

// -------------------------------------------------------------- ai bridge

// Persist conversations on any change (debounced) and flush them on quit, so
// each terminal's agent chat survives a restart / shutdown.
useAiStore.subscribe(scheduleSave)
onQuitFlush(() => persistConversations(useAiStore.getState()))

// Follow the active terminal: keep the global activeId (used by the AI side
// panel / crew list) pointed at whichever chat belongs to the focused terminal.
onBus('terminal:focus', ({ sessionId }) => {
  const conv = convForSession(useAiStore.getState(), sessionId)
  if (conv && useAiStore.getState().activeId !== conv.id) {
    useAiStore.setState({ activeId: conv.id })
  }
})

// QA hooks: let the offscreen harness drive an agent turn and read back the
// active conversation (verifies the native Claude Code path end-to-end).
;(
  window as unknown as {
    __zaryaAskAgent?: (text: string, engine?: 'builtin' | AgentEngine) => void
    __zaryaDumpConv?: () => unknown
  }
).__zaryaAskAgent = (text, engine = 'builtin') => {
  const store = useAiStore.getState()
  const sid = useSessionsStore.getState().activeSessionId() ?? undefined
  const id = store.newConversation({ sessionId: sid, engine })
  store.setActiveConversation(id)
  void store.send(text, { conversationId: id })
}
// Ф5: start an agent turn on a SPECIFIC engine and return its conversation id,
// so the concurrent harness can drive two engines in one terminal and read each
// conversation back by id (proving events never cross between them).
// Прогонам многопанельного режима нужно адресовать КОНКРЕТНУЮ панель и беседу:
// «активная» тут не годится — проверяется как раз то, что панели независимы.
;(
  window as unknown as { __zaryaStartAgentIn?: (e: AgentEngine, t: string, sid: string) => string }
).__zaryaStartAgentIn = (engine, text, sessionId) => {
  const store = useAiStore.getState()
  const id = store.newConversation({ sessionId, engine })
  store.setActiveConversation(id)
  void store.send(text, { conversationId: id })
  return id
}
;(
  window as unknown as { __zaryaConvNotice?: (convId: string, text: string) => void }
).__zaryaConvNotice = (convId, text) => {
  /*
   * Служебная отметка в ленте — например, что откат состоялся.
   *
   * Пишем ЧИСЛА и только их: лента уезжает на диск и в стенограмму, а полные
   * пути чужих проектов остались бы там навсегда. Подробный список живёт в
   * карточке, которая никуда не сохраняется.
   */
  useAiStore.setState((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === convId
        ? {
            ...c,
            messages: [
              ...c.messages,
              {
                role: 'assistant' as const,
                content: [{ type: 'notice' as const, level: 'info' as const, text }]
              }
            ]
          }
        : c
    )
  }))
}
;(
  window as unknown as { __zaryaSetBypassFor?: (convId: string, on: boolean) => void }
).__zaryaSetBypassFor = (convId, on) => useAiStore.getState().setBypass(convId, on)

// Разрешение «до конца сессии» из прогона: проверяется не кнопка, а то, что
// после неё ТА ЖЕ команда проходит молча, а другая — нет.
;(
  window as unknown as { __zaryaAllowForSession?: (convId: string, toolId: string) => void }
).__zaryaAllowForSession = (convId, toolId) =>
  void useAiStore.getState().allowForSession(convId, toolId)

// Второй ход В ТОЙ ЖЕ беседе. Правила «до конца сессии» — свойство беседы, и
// проверять их новым запуском бессмысленно: у новой беседы своих правил нет,
// как и должно быть.
/*
 * Отказ читать консоль — ПО ПАНЕЛИ, а не только по беседе.
 *
 * Наблюдаемое состояние: от карты зависит, унаследует ли отказ новый разговор,
 * открытый в том же окне. По беседам этого не видно — они уже помечены, — а
 * ревью поймало ровно случай, где карта терялась и отказ переживал перезапуск
 * наполовину.
 */
;(window as unknown as { __zaryaTailOffFor?: (sessionId: string) => boolean }).__zaryaTailOffFor = (
  sessionId
) => useAiStore.getState().shellTailOffBySession[sessionId] === true
/*
 * Отправить вопрос СБОКУ — тем же путём, что и кнопка в баре.
 *
 * Живому прогону нужен именно этот путь: обещание «дальше не поедет» держится
 * на точке ветки, снятой перед отправкой, и проверять его в обход `send` значит
 * проверять не ту дорогу.
 */
/*
 * Подменить заполнение контекста беседы — прогону порогов.
 *
 * Настоящее число приходит от движка, и дождаться от него ровно 88%% нельзя:
 * оно зависит от длины разговора. Проверяется не арифметика движка, а наш
 * порог «почти полно» и то, что показатель принадлежит своей беседе.
 */
;(
  window as unknown as {
    __zaryaSeedContext?: (convId: string, ctx: { pct?: number; tokens?: number; window?: number }) => void
  }
).__zaryaSeedContext = (convId, ctx) =>
  useAiStore.setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === convId ? { ...c, context: ctx } : c))
  }))
/**
 * Прогону: записать паре панелей трату, как будто ходы уже были.
 *
 * Настоящим путём предохранитель не проверить: подставной движок называет
 * цену хода в центах, и до предела пришлось бы гнать сотни записок — прогон
 * стал бы часовым, а проверял бы всё равно не то. Здесь мы ставим ровно то
 * состояние, ради которого предохранитель заведён, и смотрим, как Заря себя
 * ведёт.
 */
;(
  window as unknown as {
    __zaryaSeedNoteSpend?: (fromConvId: string, toConvId: string, usd: number) => number
  }
).__zaryaSeedNoteSpend = (fromConvId, toConvId, usd) => {
  const key = pairKey(fromConvId, toConvId)
  notePairSpend.set(key, rememberSpend(notePairSpend.get(key), Date.now(), usd))
  return spentInHour(notePairSpend.get(key), Date.now())
}
;(window as unknown as { __zaryaSendSide?: (convId: string, text: string) => void }).__zaryaSendSide =
  (convId, text) => void useAiStore.getState().send(text, { conversationId: convId, side: true })
;(window as unknown as { __zaryaSendIn?: (convId: string, text: string) => void }).__zaryaSendIn = (
  convId,
  text
) => void useAiStore.getState().send(text, { conversationId: convId })
/** Правка беседы для прогонов скорости — тем же путём, что и настоящая. */
function seedPatch(convId: string, fn: (c: Conversation) => Conversation): void {
  useAiStore.setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === convId ? fn(c) : c))
  }))
}
/**
 * Прогону скорости: длинная беседа, как к вечеру рабочего дня — с разметкой,
 * запусками инструментов и их результатами. Настоящий агент такую пишет
 * полчаса, а мерить надо ленту, а не агента.
 */
;(
  window as unknown as { __zaryaSeedConversation?: (sessionId: string, turns: number) => string }
).__zaryaSeedConversation = (sessionId, turns) => {
  const store = useAiStore.getState()
  const id = store.newConversation({ sessionId, engine: 'claude-code' })
  const messages: AiMessage[] = []
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `Вопрос номер ${i}` }] })
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            `### Ответ ${i}\n\nСмотри, тут **важное** и \`код\`:\n\n` +
            '```ts\nconst x = ' +
            i +
            '\nconsole.log(x)\n```\n\n' +
            `- пункт раз\n- пункт два\n- пункт три\n\nИ ещё абзац текста про панели, ленту и всё остальное, чтобы разметка была не в одну строку.`
        },
        { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `C:/p/file${i}.ts` } }
      ]
    })
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: `t${i}`, content: `прочитано ${i}`, isError: false }
      ]
    })
  }
  seedPatch(id, (c) => ({ ...c, messages }))
  return id
}
/** Прогону скорости: один чанк потока — дописать текст в последний ответ. */
;(
  window as unknown as { __zaryaSeedChunk?: (convId: string, text: string) => void }
).__zaryaSeedChunk = (convId, text) => {
  seedPatch(convId, (c) => {
    const messages = [...c.messages]
    const last = messages[messages.length - 1]
    if (!last) return c
    const parts = [...last.content]
    const tail = parts[parts.length - 1]
    parts[parts.length - 1] =
      tail?.type === 'text' ? { ...tail, text: tail.text + text } : { type: 'text', text }
    messages[messages.length - 1] = { ...last, content: parts }
    return { ...c, messages, streaming: true }
  })
}
;(
  window as unknown as { __zaryaStartAgent?: (engine: AgentEngine, text: string) => string }
).__zaryaStartAgent = (engine, text) => {
  const store = useAiStore.getState()
  const sid = useSessionsStore.getState().activeSessionId() ?? undefined
  const id = store.newConversation({ sessionId: sid, engine })
  store.setActiveConversation(id)
  void store.send(text, { conversationId: id })
  return id
}
// Ф4: force the resume path — create a conversation that already carries a
// prior session id (as a restored one would), so dispatch sends opts.resume and
// the driver goes through thread/resume instead of thread/start.
;(
  window as unknown as {
    __zaryaResumeAgent?: (engine: AgentEngine, sessionId: string, text: string) => string
  }
).__zaryaResumeAgent = (engine, sessionId, text) => {
  const store = useAiStore.getState()
  const sid = useSessionsStore.getState().activeSessionId() ?? undefined
  const id = store.newConversation({ sessionId: sid, engine })
  useAiStore.setState((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? { ...c, claudeSessionId: sessionId } : c
    )
  }))
  store.setActiveConversation(id)
  void store.send(text, { conversationId: id })
  return id
}
;(
  window as unknown as { __zaryaListModels?: (engine: AgentEngine) => Promise<unknown> }
).__zaryaListModels = (engine) => window.zarya.agent.listModels(engine)
;(window as unknown as { __zaryaConvById?: (id: string) => unknown }).__zaryaConvById = (id) => {
  const c = useAiStore.getState().conversations.find((x) => x.id === id)
  return c
    ? {
        id: c.id,
        engine: c.engine,
        streaming: c.streaming,
        error: c.error,
        sessionId: c.claudeSessionId,
        // Точка ветки после отмены отправленного: без неё «сообщение ушло из
        // контекста» проверить нечем — харнесс обязан видеть, с чем уйдёт
        // следующий ход.
        resumeAt: c.resumeAt,
        // «Сказала, что ждёт ответа» — заявление модели, а не состояние гейтов:
        // прогон обязан отличать одно от другого, иначе проверит не то.
        awaiting: c.awaiting ? { pane: c.awaiting.pane, convId: c.awaiting.convId } : null,
        // Очередь — часть наблюдаемого состояния: на ней держится семантика Esc
        // (забрать приписку обратно, не трогая агента), и проверять её нужно
        // по конкретной беседе, а не только по активной.
        queued: c.queued,
        bypass: c.bypass === true,
        // Правила «до конца сессии» — часть наблюдаемого состояния: на них
        // держится ответ на вопрос «почему в этот раз не спросили», и прогон
        // обязан видеть их дословно, а не догадываться по поведению.
        sessionAllows: c.sessionAllows ?? [],
        /*
         * Папки сверх рабочей — такое же разрешение, как правило выше, и в
         * наблюдаемом состоянии по той же причине: панель показывает СПИСОК, а
         * доступ даёт то, что уедет драйверу. Прогон обязан видеть второе.
         */
        extraDirs: c.extraDirs ?? [],
        /*
         * Копии файлов у ЖИВОЙ сессии и точки отката по ходам.
         *
         * Это наблюдаемое состояние, потому что от него зависит, покажем ли мы
         * кнопку отката и куда она поведёт. Проверять по экрану нельзя: кнопка
         * появится позже и по другим причинам, а спор идёт о том, к какому
         * ходу привязалась точка.
         */
        checkpointing: c.checkpointing === true,
        /*
         * Кто в фоне — наблюдаемое состояние: на нём держится счётчик и вся
         * проверка inc-35. По экрану это не проверить — карточка уехавшей в фон
         * задачи выглядит как обычная, задержавшаяся.
         */
        background: c.background ?? [],
        /*
         * Виды частей ленты. По экрану записку от соседней панели не отличить
         * от обычного текста наверняка — а весь вопрос inc-41 именно в том, что
         * она НЕ текст человека и не ответ агента.
         */
        partKinds: c.messages.flatMap((m) => m.content.map((p) => p.type)),
        /*
         * Записки — отдельным полем, и это не удобство прогона, а следствие
         * главного решения инкремента: в `text` они НЕ попадают, потому что не
         * являются ни словами человека, ни ответом агента.
         */
        noteTexts: c.messages.flatMap((m) =>
          m.content.filter((p) => p.type === 'pane-note').map((p) => p.text)
        ),
        /*
         * Придержана ли записка и почему. Без этого «агент не ответил» читается
         * как поломка доставки, хотя может быть законной задержкой: автопилот
         * или занятая панель.
         */
        noteHeld: c.messages.flatMap((m) =>
          m.content
            .filter(
              (p): p is Extract<AiContentPart, { type: 'pane-note' }> => p.type === 'pane-note'
            )
            .map((p) => p.held ?? 'no')
        ),
        /*
         * ХВОСТ КОНСОЛИ — наблюдаемое состояние, и без него inc-42 не проверить.
         *
         * Спор идёт ровно о том, чего на экране не видно: попали ли команды
         * человека в ТЕКСТ, уехавший модели, и совпадает ли он с тем, о чём
         * плашка отчиталась человеку. Плашка может быть права, а промпт пуст —
         * и наоборот, и это разные поломки.
         */
        /*
         * Пометки боковых вопросов: сбылось ли обещание «дальше не поедет».
         * По экрану видно только надпись, а спор идёт о том, совпала ли она с
         * тем, что реально произошло с контекстом.
         */
        sideMarks: c.messages.flatMap((m) =>
          m.content
            .filter((p): p is Extract<AiContentPart, { type: 'side-mark' }> => p.type === 'side-mark')
            .map((p) => p.kept)
        ),
        /*
         * ПОСЛЕДНИЙ ОТВЕТ АГЕНТА отдельно от всей ленты.
         *
         * Прогон бокового вопроса спрашивает «что ты помнишь?», и искать ответ
         * во всём тексте беседы нельзя: там же лежит и реплика человека, где
         * это слово было названо. Прогон падал именно на этом, хотя агент
         * честно забыл — вопрос был к прибору, а не к коду.
         */
        lastAnswer: (() => {
          /*
           * Последнее сообщение агента СО СЛОВАМИ, а не просто последнее.
           *
           * Итог хода приезжает отдельным сообщением той же роли и текста не
           * содержит вовсе. Пока хук брал «последнее assistant», прогон читал
           * пустоту и винил проверяемую фичу — так и случилось с инструментами
           * блоков: агент всё сделал верно, а прибор показал ничего.
           *
           * И ТОЛЬКО ПОСЛЕ ПОСЛЕДНЕГО ВОПРОСА ЧЕЛОВЕКА. Иначе, когда ход
           * закончился совсем без слов, поиск уезжал в прошлое и отдавал ответ
           * на ПРЕДЫДУЩИЙ вопрос. Прогон принял бы его за ответ на нынешний и
           * позеленел бы на пустом месте — прибор, который врёт в нашу пользу,
           * хуже прибора, который молчит.
           */
          const askedAt = c.messages.map((m) => m.role).lastIndexOf('user')
          const last = [...c.messages]
            .slice(askedAt + 1)
            .reverse()
            .find(
              (m) =>
                m.role === 'assistant' &&
                m.content.some((p) => p.type === 'text' && (p as { text: string }).text.trim())
            )
          return (last?.content ?? [])
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('\n')
        })(),
        /** Куда беседа вернётся, когда боковой ход кончится (пусто — некуда). */
        sideBack: c.sideBack ? { at: c.sideBack.at } : null,
        /* Заполнение контекста ЭТОЙ беседы: постоянный показатель обязан
           показывать её число, а не последнего ответившего движка. */
        context: c.context ?? null,
        shellTailOff: c.shellTailOff === true,
        // Панель, которой принадлежит беседа. Не путать с `sessionId` выше —
        // там id сессии ДВИЖКА; прогону же нужно окно терминала, потому что
        // отказ читать консоль живёт именно на нём.
        paneId: c.sessionId ?? null,
        shellTails: c.messages.flatMap((m) =>
          m.content
            .filter(
              (p): p is Extract<AiContentPart, { type: 'shell-tail' }> => p.type === 'shell-tail'
            )
            .map((p) => ({
              used: p.used.map((u) => u.command),
              dropped: p.dropped ?? 0,
              // Длина, а не текст: сам вывод бывает в тысячи символов, и тащить
              // его через мост ради проверки «доехал ли» незачем.
              chars: p.text.length,
              wrapped: p.text.includes('<untrusted-terminal-output>')
            }))
        ),
        turnMarks: c.messages.map((m) => ({ role: m.role, turnId: m.turnId ?? null })),
        userTexts: c.messages
          .filter((m) => m.role === 'user')
          .map((m) =>
            m.content
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join(' ')
          ),
        text: c.messages
          .flatMap((m) => m.content)
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('\n'),
        pendingTools: c.pendingTools.map((t) => ({
          id: t.id,
          kind: t.kind,
          name: t.name,
          settled: t.settled,
          // Почему гейт показан вопреки автопилоту. Без этого прогон не отличит
          // «пол сработал» от «автопилот не включился».
          irreversible: t.irreversible,
          // `label` is what the approval card actually shows. A harness that only
          // saw id/name could not tell a gate describing its files from one
          // reading a bare «ApplyPatch» — the exact defect this dump must catch.
          label: gateLabel(t),
          input: t.input,
          displayName: t.displayName,
          // Признак «разрешение только навсегда» — часть наблюдаемого состояния
          // гейта: от него зависит и надпись на кнопке, и то, что уйдёт агенту.
          allowAlwaysOnly: t.allowAlwaysOnly,
          // Пометка стороннего сервера. Отдельно от `irreversible`: прогон
          // обязан различать наше утверждение и чужое — на экране это разные
          // строки, и путать их нельзя ни человеку, ни харнессу.
          mcpMark: t.mcpMark
        })),
        msgs: c.messages.length,
        // Во сколько обошёлся разговор: прогон обязан видеть, что сумма КОПИТСЯ
        // по ходам, а не переписывается последним.
        costUsd: c.costUsd
      }
    : null
}
;(window as unknown as { __zaryaConvFor?: (sessionId: string) => unknown }).__zaryaConvFor = (
  sessionId
) => {
  const c = convForSession(useAiStore.getState(), sessionId)
  return c
    ? {
        id: c.id,
        engine: c.engine,
        sessionId: c.sessionId,
        cwd: c.cwd,
        claudeSessionId: c.claudeSessionId,
        msgs: c.messages.length,
        firstUser: c.messages
          .find((m) => m.role === 'user')
          ?.content?.find((p) => p.type === 'text')
          ?.text?.slice(0, 50)
      }
    : null
}
;(window as unknown as { __zaryaFollowUp?: (text: string) => void }).__zaryaFollowUp = (text) => {
  const sid = useSessionsStore.getState().activeSessionId()
  const c = convForSession(useAiStore.getState(), sid) ?? useAiStore.getState().activeConversation()
  if (c) void useAiStore.getState().send(text, { conversationId: c.id })
}
/*
 * QA-хук: отправить в КОНКРЕТНУЮ беседу, а не в активную.
 *
 * `__zaryaFollowUp` пишет туда, где стоит фокус, — а прогону записок нужны две
 * панели разом: одна пишет, вторая слушает. Без адресной отправки оба хода
 * уходили бы в одну и ту же беседу.
 */
/* QA-хук: закрыть беседу — тем же путём, что и крестик на панели. */
;(window as unknown as { __zaryaDeleteConv?: (id: string) => void }).__zaryaDeleteConv = (id) => {
  useAiStore.getState().deleteConversation(id)
}
/* QA-хук: встать в другую беседу — так же, как это делает щелчок человека. */
;(window as unknown as { __zaryaSetActiveConv?: (id: string) => void }).__zaryaSetActiveConv = (
  id
) => {
  useAiStore.getState().setActiveConversation(id)
}
;(window as unknown as { __zaryaSendTo?: (convId: string, text: string) => void }).__zaryaSendTo = (
  convId,
  text
) => {
  void useAiStore.getState().send(text, { conversationId: convId })
}
;(window as unknown as { __zaryaDumpConv?: () => unknown }).__zaryaDumpConv = () => {
  const c = useAiStore.getState().activeConversation()
  return c
    ? {
        engine: c.engine,
        streaming: c.streaming,
        error: c.error,
        messages: c.messages,
        pendingTools: c.pendingTools,
        queued: c.queued,
        // Ступени допуска — прогонам: «правки без спроса» и автопилот это разные
        // состояния, и проверять их надо порознь.
        bypass: !!c.bypass,
        editsAuto: !!c.editsAuto,
        /*
         * Наблюдение за живым ходом (inc-27). В ленте это видно глазами, но
         * прогону с НАСТОЯЩИМ движком надо знать не «нарисовалось ли», а
         * «прислал ли движок»: разница между «мы не показываем» и «нам не
         * присылают» — это разница между нашей ошибкой и чужим молчанием.
         */
        typedTool: c.typedTool,
        toolPulses: c.toolPulses,
        toolImages: Object.fromEntries(
          Object.entries(c.toolImages ?? {}).map(([k, v]) => [
            k,
            v.map((i) => ({ mediaType: i.mediaType, bytes: i.bytes }))
          ])
        )
      }
    : null
}
;(window as unknown as { __zaryaPendingImages?: (sid: string) => unknown[] }).__zaryaPendingImages =
  (sid) =>
    (useAiStore.getState().pendingImages[sid] ?? []).map((a) => ({
      id: a.id,
      mediaType: a.mediaType,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      name: a.name
    }))
;(window as unknown as { __zaryaQueue?: (t: string) => void }).__zaryaQueue = (t) => {
  const c = useAiStore.getState().activeConversation()
  if (c) useAiStore.getState().queueMessage(c.id, t)
}
// Прогонам: ступень «правки без спроса» ДО первой беседы — решение принадлежит
// панели, и живой прогон обязан ставить его тем же путём, что и человек чипом.
;(
  window as unknown as { __zaryaSetPaneEditsAuto?: (sid: string, on: boolean) => void }
).__zaryaSetPaneEditsAuto = (sid, on) => useAiStore.getState().setPaneEditsAuto(sid, on)
;(window as unknown as { __zaryaBypassLive?: (on: boolean) => void }).__zaryaBypassLive = (on) => {
  const c = useAiStore.getState().activeConversation()
  if (c) {
    useAiStore.getState().setBypass(c.id, on)
    return
  }
  const sid = useSessionsStore.getState().activeSessionId()
  if (sid) useAiStore.getState().setPaneBypass(sid, on)
}
;(window as unknown as { __zaryaApplyModelLive?: (model: string) => void }).__zaryaApplyModelLive =
  (model) => {
    const cur = getSettings().ai
    void useSettingsStore.getState().update({ ai: { ...cur, claudeModel: model } })
    const c = useAiStore.getState().activeConversation()
    if (c && c.engine !== 'builtin') window.zarya.agent.setModel(c.engine, c.id, model || undefined)
  }
;(
  window as unknown as {
    __zaryaSetClaudeCfg?: (model?: string, effort?: string, bypass?: boolean) => void
  }
).__zaryaSetClaudeCfg = (model, effort, bypass) => {
  const cur = getSettings().ai
  void useSettingsStore.getState().update({
    ai: {
      ...cur,
      claudeModel: model ?? cur.claudeModel,
      claudeEffort: effort ?? cur.claudeEffort
    }
  })
  if (bypass !== undefined) {
    const c = useAiStore.getState().activeConversation()
    if (c) useAiStore.getState().setBypass(c.id, bypass)
  }
}
/*
 * QA-хук: одобрить карточку в КОНКРЕТНОЙ беседе.
 *
 * `__zaryaApproveFirst` жмёт в активной — а прогонам про две панели нужна
 * адресная: карточка висит у соседа, пока фокус стоит на отправителе.
 */
;(window as unknown as { __zaryaApproveIn?: (id: string) => void }).__zaryaApproveIn = (id) => {
  const c = useAiStore.getState().conversations.find((x) => x.id === id)
  const t = c?.pendingTools.find((x) => !x.settled)
  if (c && t) void useAiStore.getState().approveTool(c.id, t.id)
}
;(window as unknown as { __zaryaApproveFirst?: () => void }).__zaryaApproveFirst = () => {
  const c = useAiStore.getState().activeConversation()
  const t = c?.pendingTools.find((x) => !x.settled)
  if (c && t) void useAiStore.getState().approveTool(c.id, t.id)
}
;(window as unknown as { __zaryaDenyFirst?: () => void }).__zaryaDenyFirst = () => {
  const c = useAiStore.getState().activeConversation()
  const t = c?.pendingTools.find((x) => !x.settled)
  if (c && t) useAiStore.getState().denyTool(c.id, t.id)
}
;(window as unknown as { __zaryaAbort?: () => void }).__zaryaAbort = () => {
  const c = useAiStore.getState().activeConversation()
  if (c) useAiStore.getState().abort(c.id)
}
;(window as unknown as { __zaryaAnswerFirst?: (label: string) => void }).__zaryaAnswerFirst = (
  label
) => {
  const c = useAiStore.getState().activeConversation()
  const t = c?.pendingTools.find((x) => x.kind === 'question' && !x.settled)
  if (c && t && t.questions?.[0]) {
    useAiStore.getState().answerQuestion(c.id, t.id, { [t.questions[0].question]: [label] })
  }
}

registerAiBridge({
  explainBlock: (block, question) => {
    useUiStore.getState().set({ aiPanelOpen: true })
    const store = useAiStore.getState()
    const active = store.activeConversation()
    const convId =
      active && !active.streaming && active.messages.length === 0
        ? active.id
        : store.newConversation({
            sessionId: block.sessionId,
            title: t('ai.explainTitle', { cmd: truncateText(block.command || t('ai.cmdWord'), 28) })
          })
    useAiStore.getState().attachBlockContext(block, convId)
    void useAiStore.getState().send(question ?? t('ai.explainPrompt'), {
      conversationId: convId
    })
  },

  openCommandBar: (sessionId) => {
    useAiStore.setState({ commandBarSessionId: sessionId })
    useUiStore.getState().set({ aiBarOpen: true })
  },

  openPanel: () => {
    useUiStore.getState().set({ aiPanelOpen: true })
    if (!useAiStore.getState().conversations.length) useAiStore.getState().newConversation()
  }
})
