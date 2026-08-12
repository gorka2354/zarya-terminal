import type { SecretProtection } from './secretProtection'
import type { CustomSttModel } from './sttCustom'

/**
 * Shared type contracts between main, preload and renderer.
 * This file is the single source of truth for cross-process data shapes.
 */

// ---------------------------------------------------------------------------
// Shell profiles & PTY
// ---------------------------------------------------------------------------

export type ShellIntegrationKind = 'powershell' | 'bash' | 'zsh' | 'none'

export interface ShellProfile {
  id: string
  name: string
  /** Absolute path to the shell executable. */
  path: string
  args: string[]
  env?: Record<string, string>
  /** Which integration script family the shell understands. */
  integration: ShellIntegrationKind
  /** Emoji or short glyph shown in tabs / pickers. */
  icon: string
  /** True for profiles detected automatically (not user-defined). */
  detected?: boolean
}

/** An external AI coding CLI Zarya can launch straight into the terminal. */
export interface AiCli {
  id: string
  name: string
  /** Full command to run (may include args, e.g. "ollama run llama3"). */
  cmd: string
  /** Short 2-char glyph for the launcher tile. */
  glyph: string
  /** Theme color token used to tint the tile ('accent' | 'accent-2'). */
  tint: 'accent' | 'accent-2'
  /** Resolved executable path, when found on PATH. */
  path: string | null
  /** True when the CLI is installed / reachable. */
  detected: boolean
  /**
   * Команда установки — только там, где мы её ЗНАЕМ.
   *
   * Пусто значит «мы не беремся утверждать, как это ставится»: подсказка с
   * выдуманной командой хуже её отсутствия — человек выполнит и получит ошибку,
   * за которую отвечать будет Заря. Для таких есть {@link site}.
   */
  install?: string
  /** Страница проекта — туда отправляем, когда команды не знаем. */
  site?: string
}

export interface PtySpawnRequest {
  sessionId: string
  profileId: string
  cwd?: string
  cols: number
  rows: number
}

export interface PtySpawnResult {
  ok: boolean
  pid?: number
  /** Actual cwd the pty started in (after fallbacks). */
  cwd?: string
  profile?: ShellProfile
  /** Per-session anti-spoofing nonce echoed back by shell integration OSC sequences. */
  nonce?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Blocks (Warp-style command blocks)
// ---------------------------------------------------------------------------

export interface BlockRecord {
  id: string
  sessionId: string
  /** The command line as reported by shell integration ('' if unknown). */
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  /** Exit code reported via OSC 133;D. undefined = still running or unknown. */
  exitCode?: number
  /** Plain-text output (ANSI stripped), capped. */
  output: string
  outputTruncated: boolean
}

// ---------------------------------------------------------------------------
// Sessions & workspace persistence
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string
  title: string
  profileId: string
  shellName: string
  shellIcon: string
  cwd: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  favorite: boolean
  blocksCount: number
  lastCommand?: string
  /** Optional user color tag (hex) shown in the sessions list / tab. */
  colorTag?: string
  /**
   * Чем панель разговаривала в последний раз: оболочка, встроенный борт или
   * движок агента.
   *
   * Живёт в снапшоте, потому что это выбор человека, а не состояние окна. Пока
   * режим хранился только в памяти, вчерашняя работа в Claude Code после
   * перезапуска молча превращалась в обычный терминал — и пусковой комплекс
   * показывал каталог совсем другого борта.
   */
  barMode?: string
}

export interface SessionSnapshot {
  meta: SessionMeta
  /** Serialized xterm scrollback (VT stream produced by @xterm/addon-serialize). */
  scrollback: string
  blocks: BlockRecord[]
}

export type SplitDirection = 'row' | 'col'

export type SplitNode =
  | { type: 'leaf'; sessionId: string }
  | { type: 'split'; dir: SplitDirection; ratio: number; a: SplitNode; b: SplitNode }

export interface TabState {
  id: string
  layout: SplitNode
  activeSessionId: string
  /**
   * Имя рабочего стола, если его задали руками.
   *
   * Без него строка вкладки подписывалась именем той панели, что была в ней
   * активной: четыре разных проекта — одно имя в списке, да ещё и меняющееся
   * при переключении фокуса внутри. Пустое поле значит «собери подпись из
   * панелей» (см. deskTitle).
   */
  title?: string
}

export interface WorkspaceState {
  tabs: TabState[]
  activeTabId: string | null
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Язык интерфейса: 'auto' — по языку системы. */
export type UiLang = 'auto' | 'ru' | 'en'

export interface AppearanceSettings {
  themeId: string
  /**
   * Язык интерфейса. Не сборка, а настройка вида: оба словаря лежат в одном
   * приложении, переключение мгновенное и без перезапуска — иначе пришлось бы
   * держать два установщика и объяснять человеку, какой ему скачивать.
   */
  language: UiLang
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  terminalPadding: number
  /** 0.3 – 1.0 window opacity. */
  windowOpacity: number
  /** Windows 11 acrylic background material. Needs restart. */
  acrylic: boolean
  uiDensity: 'cozy' | 'compact'
}

export interface TerminalSettings {
  scrollback: number
  copyOnSelect: boolean
  rightClickBehavior: 'paste' | 'menu'
  pasteWarnMultiline: boolean
  webgl: boolean
  defaultProfileId: string
  /** User-defined profiles merged with auto-detected ones. */
  customProfiles: ShellProfile[]
  bell: 'none' | 'visual'
  confirmCloseRunning: boolean
}

export interface BlocksSettings {
  enabled: boolean
  separators: boolean
  exitBadges: boolean
  /** Fish-style ghost-text suggestions from history. */
  autosuggest: boolean
}

export type AiProviderKind = 'anthropic' | 'openai' | 'ollama' | 'openai-compat'

/** Reasoning "thrust" (тяга) — 4 levels mapped to temperature + token budget. */
export type AiEffort = 'low' | 'medium' | 'high' | 'max'

export interface AiSettings {
  provider: AiProviderKind
  model: string
  /** Base URL override (required for ollama / openai-compat). */
  baseUrl: string
  /** Reasoning thrust; drives temperature + maxTokens when set. */
  effort: AiEffort
  temperature: number
  maxTokens: number
  /**
   * Auto-approve `run_command` for the BUILT-IN Zarya agent (dangerous, off by
   * default). Scoped to that engine on purpose — it must never be mapped onto a
   * native driver's {@link AgentPermissionMode}: weakening a native gate is the
   * job of АВТОПИЛОТ ({@link claudeBypass}) and only of it, so the bar's chip can
   * always state the truth about whether you will be asked.
   */
  autoApprove: boolean
  /** How many recent blocks to attach as context automatically. */
  contextBlocks: number
  /**
   * Просить Claude Code хранить копии файлов перед правками — для отката кода.
   *
   * Плата за это лежит ВНЕ нашей папки: движок кладёт полные копии содержимого
   * открытым текстом в `~/.claude/file-history` и удаляет их вместе с сессией
   * по своей настройке. Поэтому по умолчанию выключено: включать чужую запись
   * на диск молча нельзя, а строка, которая честно называет цену (включая
   * `.env` и ключи, если агент их правил), появится вместе с экраном настроек.
   */
  fileCheckpoints: boolean
  /**
   * Модели, которые человек уже видел, по провайдеру.
   *
   * Нужны, чтобы сказать «появилась новая модель» ровно один раз. Сравнение
   * идёт с ВИДЕННЫМ, а не с прошлым ответом: иначе отвалившаяся на минуту сеть
   * объявила бы новинкой то, что человеку уже показывали.
   */
  seenModels?: Record<string, string[]>
  /** Extra instructions appended to the system prompt. */
  systemPromptExtra: string
  /**
   * Приписка к системному промпту НАТИВНОГО движка (`--append-system-prompt`).
   *
   * Отдельно от `systemPromptExtra`: тот собирается для встроенного борта, у
   * которого промпт наш целиком. Здесь — дополнение к чужому промпту, и одно
   * поле на оба случая однажды унесло бы правило не туда, куда человек его
   * писал.
   */
  enginePromptExtra: string
  /** Claude Code model override ('' = account default from ~/.claude). */
  claudeModel: string
  /** Claude Code effort override ('' = account default). */
  claudeEffort: string
  /**
   * АВТОПИЛОТ здесь БОЛЬШЕ НЕ ЖИВЁТ (inc-17): он стал свойством беседы.
   *
   * Одна настройка на окно с несколькими панелями неизбежно врёт: выключаешь её,
   * глядя на одну панель, — гаснут чипы во всех, а работающий агент в третьей
   * продолжает выполнять команды сам. Поэтому решение принимается для каждой
   * беседы отдельно (Conversation.bypass), новая панель всегда открывается со
   * спрашиванием, и наследовать автопилот неоткуда.
   */
}

/** Диктовка: какой микрофон слушать. Распознавание всегда локальное. */
export interface VoiceSettings {
  /**
   * Устройство ввода. '' = системное по умолчанию (следует за настройкой ОС).
   * Chromium солит deviceId для каждого origin — id переживает перезапуск, но
   * не переустановку драйвера, поэтому рядом хранится имя (см. deviceLabel).
   */
  deviceId: string
  /**
   * Имя устройства на момент выбора. Единственный способ узнать «ту же
   * гарнитуру» после того, как id сменился: по нему выбор чинится молча,
   * вместо тихого переключения на встроенный микрофон ноутбука.
   */
  deviceLabel: string
  /**
   * Какая модель распознавания выбрана (id из реестра или своей модели). Пусто
   * — модель по умолчанию. Встроенный список закрытый и живёт в коде:
   * настраиваемый АДРЕС был бы способом скачать в нативный движок что угодно
   * откуда угодно.
   */
  modelId: string
  /**
   * Свои модели: те, что человек принёс с диска сам. Путь сюда попадает только
   * из системного диалога в главном процессе — это жест «Открыть файл», а не
   * канал, в который renderer может подать произвольный путь.
   *
   * Файлы остаются там, где лежат: модель весит сотни мегабайт, и копия внутри
   * userData была бы вторым таким же грузом на диске.
   */
  customModels: CustomSttModel[]
}

/** Проверка обновлений: один анонимный запрос к GitHub, без телеметрии. */
export interface UpdateSettings {
  /**
   * Проверять при запуске. Включено по умолчанию: терминал, молча пропускающий
   * security-фиксы, хуже, чем один анонимный GET. Выключается одним щелчком.
   */
  check: boolean
}

/**
 * История команд («Хроника»). Терминальные команды регулярно содержат секреты —
 * токены в переменных окружения, ключи в аргументах curl, пароли в строках
 * подключения. Файл рос бесконечно, отключить его было нельзя, очистить тоже.
 */
export interface HistorySettings {
  /** Записывать ли команды вообще. */
  record: boolean
  /**
   * Сколько последних команд хранить. Ноль — не ограничивать (файл снова растёт
   * бесконечно, но это уже осознанный выбор, а не молчаливое поведение).
   */
  maxEntries: number
}

export interface NotificationSettings {
  /**
   * Звать, когда агент встал и ждёт решения, а окно не в фокусе.
   *
   * Только в этом случае: уведомление о том, что и так видно на экране, —
   * шум, а шум выключают вместе с сигналом. Включено по умолчанию, потому что
   * ожидание уже происходит и без нас; человек просто о нём не знает.
   */
  whenWaiting: boolean
  /**
   * Звать, когда закончилась ДОЛГАЯ команда, а окно не в фокусе.
   *
   * Сборка идёт восемь минут, человек уходит в браузер и возвращается через
   * двадцать — половину этого времени терминал простоял с готовым ответом.
   * Порог отсекает `ls` и `git status`: зов о том, что кончилось быстрее, чем
   * человек отвернулся, — шум.
   */
  whenLongDone: boolean
}

export interface SessionsSettings {
  restoreOnLaunch: 'workspace' | 'none'
  autosaveSec: number
  scrollbackSaveLines: number
  /**
   * Свёрнутые разделы сайдбара ('open' | 'favorites' | 'recent' | 'crew').
   *
   * В настройках, а не в памяти окна: человек сворачивает раздел, потому что
   * тот ему мешает, — и мешать он перестаёт навсегда, а не до перезапуска.
   * «Недавние» свёрнуты по умолчанию: список растёт сам собой и к сотне строк
   * закрывает собой всё живое.
   */
  collapsed?: string[]
}

export interface EditorSettings {
  fontSize: number
  wordWrap: boolean
  minimap: boolean
  tabSize: number
}

export interface Settings {
  appearance: AppearanceSettings
  terminal: TerminalSettings
  blocks: BlocksSettings
  ai: AiSettings
  voice: VoiceSettings
  updates: UpdateSettings
  history: HistorySettings
  sessions: SessionsSettings
  notifications: NotificationSettings
  editor: EditorSettings
  /** actionId -> chord, e.g. "terminal.split-right": "Ctrl+Shift+D". */
  keybindings: Record<string, string>
  /** Bookmarked directories for quick cd. */
  bookmarks: string[]
  /**
   * IDE superstructure (Files, Monaco editor, Workflows, the IDE-agent panel and
   * their settings) layered over the base terminal. Off by default — the base
   * stays a clean terminal + Claude Code agent until you opt in.
   */
  ideMode: boolean
  /**
   * Первый экран уже показывали.
   *
   * Живёт в настройках и НИКУДА не уходит: знакомство — единственная минута,
   * когда легче всего завести «анонимный идентификатор только для метрик», за
   * который мы ругаем соседей. Здесь просто галочка «видел», и всё, что человек
   * ответил на первом экране, применяется к его же интерфейсу.
   */
  onboarded: boolean
}

// ---------------------------------------------------------------------------
// AI transport (renderer builds requests; main process holds keys and streams)
// ---------------------------------------------------------------------------

export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      toolUseId: string
      content: string
      isError?: boolean
      /**
       * СКОЛЬКО картинок вернул инструмент — а не сами картинки.
       *
       * Сами байты живут отдельно, в открытой беседе (`Conversation.toolImages`),
       * и на диск не попадают: беседа переписывается целиком раз в несколько сот
       * миллисекунд, и сотня скриншотов от MCP-сервера браузера превратила бы
       * каждое сохранение в мегабайты. Число остаётся, чтобы восстановленная
       * карточка могла сказать об этом словами, а не показать пустоту.
       */
      images?: number
      /** Сколько картинок отклонено форматом или размером. */
      imagesSkipped?: number
      /** Сколько не поместилось ЧИСЛОМ — это другая причина, и слова другие. */
      imagesOverflow?: number
      /**
       * Факты о результате: ключи словаря с подстановками, а не готовые фразы.
       * Так строка меняет язык вместе с интерфейсом — и в уже сохранённой
       * беседе тоже.
       */
      facts?: import('./toolFacts').ToolFact[]
    }
  /**
   * Вставленное изображение. `data` — base64 без префикса data:. Пределы и
   * допустимые типы живут в @shared/images: расползшийся предел это предел,
   * который где-то не проверяется.
   */
  | {
      type: 'image'
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
      bytes: number
      width: number
      height: number
      name?: string
    }
  /**
   * Строка движка в ленте: ход оборвался, модель отказала, хук вмешался.
   *
   * Отдельный вид, а не текст: у неё своя роль и свой вид на экране — это не
   * ответ агента, а объяснение того, почему ответа не будет.
   */
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /**
   * Отметка о сжатии контекста. Числа — движка; своей арифметики не изобретаем,
   * а «примерно» здесь было бы хуже молчания.
   */
  | { type: 'compact'; before?: number; after?: number; auto?: boolean }
  /**
   * Черта: выше — то, чего агент больше не помнит.
   *
   * Не то же, что сжатие: там разговор остался пересказом, здесь его нет
   * вовсе. Записи человека при этом на месте — стирать их было бы куда хуже,
   * чем показать границу.
   */
  /**
   * Рассуждение модели: то, что в консоли разворачивают по Ctrl+O.
   *
   * Отдельным видом, а не текстом: это НЕ ответ агента, а его черновик мысли.
   * Смешать их значило бы выдать размышление за вывод — и в ленте, и в
   * стенограмме, и в памяти беседы.
   */
  | { type: 'thinking'; text: string }
  | { type: 'reset' }
  /**
   * Итог хода: сколько он длился, через сколько заговорил, чем кончился.
   *
   * В консоли эта строка есть, в Заре не было ничего: «12 секунд думал» и
   * «висел 12 секунд» выглядели одинаково, а лимит ходов, потолок трат и отказ
   * модели сливались в одно слово «ошибка». Показывается не всегда — молчаливый
   * успех в объяснении не нуждается (см. `endReasonText`).
   */
  | {
      type: 'turn'
      durationMs?: number
      ttftMs?: number
      turns?: number
      denials?: number
      endReason?: string
      isError?: boolean
    }

export interface AiMessage {
  role: 'user' | 'assistant'
  content: AiContentPart[]
  /**
   * Точка отката файлов для ЭТОГО хода (uuid сообщения в движке).
   *
   * Живёт в беседе и уезжает на диск вместе с ней: откат переживает перезапуск
   * приложения, а без сохранённого id вернуться было бы некуда.
   */
  turnId?: string
  /** When the message was created (ms epoch) — shown as a right-aligned time in
   *  the feed for user turns. Optional: older/persisted messages may lack it. */
  ts?: number
}

/**
 * Чем закончился откат файлов — или чем он закончился бы (сухой прогон).
 *
 * Числа берём у движка, но НЕ доверяем им как отчёту: он не считает часть
 * своих же промахов (пропавшая резервная копия не попадает никуда), поэтому
 * рядом едет наша пост-сверка. См. `inc/inc-33-otkat-koda.md`.
 */
export interface RewindFilesOutcome {
  /** Откат возможен (для сухого прогона — «было бы возможно»). */
  canRewind: boolean
  /** Слова движка о причине отказа — дословно, своих не придумываем. */
  error?: string
  /** Пути, которых коснётся откат. Пустой список — не «ничего не изменится». */
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  /** Сколько путей движок пропустил (симлинки и прочее не-обычное). */
  skippedLinks?: number
  /** Отказ НАШЕЙ стороны, до движка. */
  refused?: 'busy' | 'no-session' | 'unsupported' | 'no-turn-id' | 'stale'
  /**
   * Что изменилось, пока человек читал карточку.
   *
   * Откат по устаревшему списку стёр бы то, о чём карточка не сказала: не
   * пишем, а показываем расхождение и требуем нового решения.
   */
  stale?: string[]
  /**
   * Что лежит на диске по этим путям (сухой прогон).
   *
   * Движок про ссылки и про выход за папку молчит до самого конца — а решение
   * человек принимает ДО.
   */
  facts?: Array<{
    path: string
    existsNow: boolean
    linkSkipped?: boolean
    outsideCwd?: boolean
    size?: number
    hash?: string
    /** Мы знаем, что записал в этот файл агент. */
    observed?: boolean
    /** На диске уже НЕ то, что записал агент: правку потеряют. */
    changedAfterAgent?: boolean
  }>
  /**
   * Копия спорных файлов, снятая ПЕРЕД откатом.
   *
   * У движка есть «до агента», но нет «до отката». Путь показывается человеку:
   * обещание «мы сохранили» без адреса, куда идти, — половина обещания.
   */
  backup?: { dir?: string; saved: number; skipped: string[] }
  /** Наша собственная сверка ПОСЛЕ отката: числам движка верить нельзя. */
  verdict?: {
    restored: number
    untouched: number
    unknown: number
    untouchedPaths: string[]
  }
}

export interface AiToolDef {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>
}

export interface AiChatRequest {
  provider: AiProviderKind
  model: string
  baseUrl?: string
  system?: string
  messages: AiMessage[]
  tools?: AiToolDef[]
  temperature?: number
  maxTokens?: number
}

export type AiStreamEvent =
  | { type: 'start' }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'done'; stopReason?: string }
  | { type: 'error'; message: string }

export interface AiProviderStatus {
  provider: AiProviderKind
  hasKey: boolean
  /**
   * Насколько ключ на самом деле защищён. Один зелёный бейдж на все случаи
   * скрывал, что при недоступном safeStorage ключ пишется открытым текстом.
   */
  protection: SecretProtection
}

/** A conversation persisted to disk (survives restart), bound to a terminal + cwd. */
export interface PersistedConversation {
  id: string
  title: string
  engine: 'builtin' | AgentEngine
  /** Terminal session this conversation belongs to. */
  sessionId?: string
  /** Claude Code session id — resumed on the next turn to keep full context. */
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
   * Точка ветки после отмены отправленного сообщения (см. {@link AgentRewind}).
   * Переживает перезапуск намеренно: без неё возобновление подтянуло бы
   * отменённое обратно в контекст, а в ленте его уже нет.
   */
  resumeAt?: string
  /** Working directory the conversation was opened in. */
  cwd?: string
  messages: AiMessage[]
  /** User turns cut off with Esc — the badge must survive a restart. */
  interrupted?: number[]
  createdAt: number
}

export interface AiConversationsState {
  conversations: PersistedConversation[]
  /** Which conversation is active per terminal session. */
  activeBySession: Record<string, string>
  /** Last known Claude Code status (model/effort/usage) for the fuel gauge. */
  claudeStatus?: { model?: string; effort?: string; usage?: ClaudeUsage }
  /** Cached SDK model catalog so the launch pad (incl. Fable) is populated on cold start. */
  claudeModels?: ClaudeModelInfo[]
}

// ---------------------------------------------------------------------------
// Native agent drivers (Claude Code today; Codex / Gemini via inc-9 AgentDriver)
//
// These shapes are the driver-agnostic contract. Claude Code was the first
// driver, so the names were originally `Claude*`; inc-9 renames the canonical
// definitions to `Agent*` and keeps `Claude*` back-compat aliases for one
// increment. A driver maps its vendor wire protocol onto these shapes; the
// renderer talks only to this contract (no per-vendor `engine === 'claude-code'`
// forks — it reads {@link AgentCapabilities} to decide which controls to show).
// ---------------------------------------------------------------------------

/** Which native agent backs a conversation. Extend as drivers land. Kimi/Qwen
 *  (inc-12) share the ACP driver with Gemini — just more engine ids. */
export type AgentEngine = 'claude-code' | 'codex' | 'gemini' | 'kimi' | 'qwen'

/** A single AskUserQuestion-style structured prompt (agent asks the user). */
export interface AgentQuestion {
  question: string
  header: string
  options: { label: string; description?: string; preview?: string }[]
  multiSelect?: boolean
}

/**
 * Only these three are representable. 'bypassPermissions'/'dontAsk' are
 * deliberately excluded: bypassPermissions shadows canUseTool entirely (which
 * would also silently auto-answer AskUserQuestion), so bypass is implemented as
 * an auto-allow INSIDE canUseTool instead — see claudeCodeDriver. The main
 * process also whitelists this at the trust boundary. Drivers whose backend has
 * no equivalent permission mode ignore it.
 *
 * 'acceptEdits' is representable but is NOT wired to any setting: it is the SDK's
 * "auto-accept file edit operations", i.e. a real gate removal for Write/Edit
 * below canUseTool, invisible to the app's own approval UI. Zarya sends
 * 'default' and expresses gate-weakening solely through `bypass`, which the bar
 * displays. Anything wiring this to a setting must also make the chip say so.
 */
export type AgentPermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface AgentStartOpts {
  /** The user's turn text. */
  prompt: string
  /**
   * Изображения этого хода. Отдельным полем, а не внутри prompt: строка их не
   * вместит, а менять тип prompt значило бы трогать все движки разом. Драйвер,
   * который картинки не умеет, просто их игнорирует — но интерфейс до этого не
   * доводит: вставка у такого движка вложения не создаёт (capabilities.images).
   */
  images?: Array<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    data: string
  }>
  /** Working directory the agent operates in (the bound session's cwd). */
  cwd?: string
  /**
   * Папки СВЕРХ рабочей, куда человек разрешил агенту заходить.
   *
   * Это разрешение, а не удобство: за пределами `cwd` движок иначе отказывает
   * сам, и расширять этот круг вправе только человек. Поэтому список приходит
   * от него явно (панель разрешений), нигде не собирается по догадке и не
   * переживает перезапуск.
   */
  extraDirs?: string[]
  /**
   * Приписка к системному промпту движка (`--append-system-prompt`).
   *
   * Именно ПРИПИСКА: движку уходит `preset: 'claude_code'` плюс это, а не
   * замена. Замена сняла бы с агента всё, что он о себе знает, — это была бы не
   * настройка, а поломка, и человек, написавший одну строку, получил бы другой
   * инструмент.
   */
  appendPrompt?: string
  /** Model id override; omit to use the driver's configured default. */
  model?: string
  /** Reasoning effort override (vendor vocabulary); omit for the account default. */
  effort?: string
  permissionMode?: AgentPermissionMode
  /** Auto-approve tool calls in canUseTool without prompting (AskUserQuestion still surfaces). */
  bypass?: boolean
  /**
   * «Правки без спроса»: ступень между вопросом на каждый вызов и автопилотом.
   * Молча пропускаются ТОЛЬКО инструменты правки файлов (см. `isEditTool`);
   * команды оболочки, сеть и незнакомое по-прежнему спрашивают.
   */
  editsAuto?: boolean
  /** Ultracode: xhigh effort + standing dynamic-workflow orchestration (Claude-only, session-scoped). */
  ultracode?: boolean
  /** Resume a prior session id (multi-turn continuity). */
  resume?: string
  /**
   * UUID ответа агента, ДО которого (включительно) брать историю `resume`.
   * Ставится после отмены отправленного сообщения: ход уходит ВЕТКОЙ от этой
   * точки, и всё, что было после неё, в контекст не попадает. Без `resume`
   * бессмысленно. См. {@link AgentRewind}.
   */
  resumeAt?: string
  /**
   * Просить движок хранить копии файлов перед правками (для будущего отката).
   *
   * Решает НЕ драйвер: это плата диском в чужой папке (`~/.claude/file-history`,
   * полные копии содержимого), и включать её молча нельзя. Значение приходит из
   * настроек приложения; драйвер вправе его не выполнить, если бинарник не
   * понимает нужный флаг (см. `supportsFlag`).
   */
  fileCheckpoints?: boolean
  /** Escape hatch for vendor-specific flags (never a required member). */
  vendorOpts?: Record<string, unknown>
}

/**
 * Ответ драйвера на отмену отправленного сообщения (Esc над ходом, на который
 * агент ещё не ответил).
 *
 * `fork` — беседа продолжится веткой от `at` в сессии `sessionId`; отменённое
 * останется в файле мёртвой веткой и в контекст не попадёт. `fresh` — отматывать
 * не к чему (агент в этой сессии ещё ничего не сказал), следующий ход начнёт
 * новую сессию. `null` (не этот тип) — движок так не умеет, и рендерер обязан
 * оставить сообщение в ленте: убрать с глаз то, что агент помнит, — враньё.
 */
export type AgentRewind = { kind: 'fork'; sessionId: string; at: string } | { kind: 'fresh' }

/** Subscription rate-limit windows (utilization %, reset time) for the fuel gauge. */
export interface AgentUsage {
  subscriptionType?: string
  fiveHourPct?: number
  fiveHourResetsAt?: number
  sevenDayPct?: number
  sevenDayResetsAt?: number
  /** Context-window fill of the last turn: how much of the model's context is
   *  used (0-100), plus the raw tokens/window for a detailed readout. */
  contextPct?: number
  contextTokens?: number
  contextWindow?: number
}

/**
 * Events streamed main -> renderer for a native agent turn. Distinct from
 * {@link AiStreamEvent} (the built-in provider agent) so neither path perturbs
 * the other; the renderer adapter maps these onto the shared Conversation shape.
 * The 8-member union is proven sufficient for a full permission-gated agentic
 * turn; a driver normalizes its vendor events onto it.
 */
export type AgentStreamEvent =
  | {
      type: 'init'
      sessionId: string
      model: string
      cwd: string
      permissionMode: string
      tools: string[]
      /** Reasoning effort from the account config (~/.claude/settings.json). */
      effort?: string
      /**
       * Эта сессия стартовала с копиями файлов — значит откат к её ходам
       * возможен.
       *
       * Правда про КОНКРЕТНУЮ сессию, а не про настройку: человек мог включить
       * тумблер посреди беседы (сессия всё равно без копий) или выключить его,
       * пока сессия живёт (копии всё равно снимаются). Настройка отвечает на
       * «чего мы хотим», это поле — на «что есть на самом деле».
       */
      checkpointing?: boolean
    }
  /**
   * Движок назвал id хода человека — точку, к которой можно вернуть файлы.
   *
   * Приходит отдельным событием, потому что сам ход давно нарисован: пузырь
   * создаётся отправкой, а id прилетает уже из потока движка.
   */
  | { type: 'turn-id'; uuid: string }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'models'; models: AgentModelInfo[] }
  /**
   * Ход оборвался не по-человечески: упёрлись в предел вывода, модель отказала,
   * кончился лимит, человек прервал.
   *
   * До этого события такой конец выглядел ровно как зависание: драйвер читал
   * только `content` и при пустом не эмитил НИЧЕГО — «думающие» точки просто
   * гасли. Молчание здесь и есть самая дорогая ложь: человек ждёт ответа,
   * которого уже не будет.
   */
  | {
      type: 'notice'
      /** Насколько это важно: от служебной строки до отказа. */
      level: 'info' | 'warn' | 'error'
      /** Текст движка, дословно. Своих формулировок не изобретаем. */
      text: string
    }
  /**
   * Контекст сжимается или уже сжат.
   *
   * `running` — идёт прямо сейчас (в консоли на этом месте строка и полоса
   * загрузки), `done` — закончилось, и тогда известны числа: сколько было и
   * сколько стало. Без этого агент внезапно «забывал» разговор, и объяснения на
   * экране не было никакого.
   */
  | {
      type: 'compact'
      phase: 'running' | 'done' | 'failed'
      /** Токенов до сжатия — цифра движка. */
      before?: number
      /** Токенов после. */
      after?: number
      /** Сжатие запустил человек или оно случилось само. */
      auto?: boolean
      error?: string
    }
  /**
   * A subagent's lifecycle. Claude Code spawns these for research/parallel work
   * and reports their cost itself, so the numbers here are the SDK's own — the
   * indicator must never invent them.
   */
  | {
      type: 'subagent'
      /** Stable id of the task (not the tool_use id). */
      taskId: string
      /** The `Agent` tool_use this task belongs to, when the SDK reports one. */
      toolUseId?: string
      phase: 'started' | 'progress' | 'done'
      /** Human description; refreshed as the subagent moves on ("Reading package.json"). */
      description?: string
      /** e.g. 'general-purpose'. Absent for plain shell tasks. */
      subagentType?: string
      /** Tokens the SDK attributes to this subagent so far. */
      totalTokens?: number
      /** Tool calls it has made so far. */
      toolUses?: number
      /** How long it has been running, per the SDK. */
      durationMs?: number
      /** Tool it is running right now. */
      lastTool?: string
      /**
       * Чем задача кончилась — слово движка, не наш вывод.
       *
       * Раньше исход не читался вовсе, и упавшей, остановленной и успешной
       * задаче рисовался один и тот же зелёный чек. Это ровно та ложь, ради
       * которой затевался весь разбор: «18 из 18» при двух упавших.
       */
      status?: 'completed' | 'failed' | 'stopped'
      /** Чем задача кончилась по существу — пересказ движка. */
      summary?: string
      /**
       * Род задачи, как его называет движок: `local_agent` (субагент),
       * `local_workflow` (воркфлоу), `remote_agent` и что появится дальше.
       * Открытый список — незнакомое НЕ глушим, иначе новое молча исчезнет.
       */
      taskType?: string
      /** Имя воркфлоу из его же скрипта. Движок шлёт только для `local_workflow`. */
      workflowName?: string
      /** Задачу увели в фон: ход пошёл дальше, а она осталась работать. */
      backgrounded?: boolean
    }
  /**
   * Кусок ответа, пока он печатается.
   *
   * Держится ОТДЕЛЬНО от истории сообщений: настоящим текстом остаётся тот,
   * что придёт целым сообщением в конце. Иначе оборванный на середине поток
   * осел бы в истории как ответ агента — и Заря помнила бы то, чего он не
   * говорил.
   */
  | { type: 'text_delta'; text: string }
  /**
   * Вызов инструмента, аргументы которого модель печатает прямо сейчас.
   *
   * Посимвольно шёл только текст ответа; когда модель сочиняет ВЫЗОВ, текста
   * нет вовсе, и на экране оставались три точки — на длинной команде секунд по
   * десять, неотличимо от зависания.
   *
   * Как и кусок текста, это ПОКАЗ, а не история: в беседу ляжет настоящий блок
   * `tool_use` из целого сообщения, и он же займёт это место на экране.
   */
  | { type: 'tool_typing'; name: string; preview: string }
  /**
   * Движок начал беседу заново: `/clear`, выход из режима плана, новая сессия.
   *
   * Ленту это НЕ стирает — там записи человека. Но номер сессии обязан
   * смениться, иначе следующий ход попросит продолжить разговор, которого у
   * движка больше нет, и Заря будет утверждать, что память на месте.
   */
  | { type: 'reset'; sessionId?: string }
  | { type: 'assistant'; content: AiContentPart[] }
  | {
      type: 'tool_result'
      toolUseId: string
      content: string
      isError: boolean
      /**
       * Картинки из результата: скриншот MCP-сервера и подобное. Раньше блок
       * `image` молча выбрасывался, и карточка вызова, вся суть которого —
       * картинка, оставалась пустой.
       */
      images?: import('./images').ToolImage[]
      /** Сколько картинок отклонено форматом или размером. */
      imagesSkipped?: number
      /** Сколько не поместилось ЧИСЛОМ — это другая причина, и слова другие. */
      imagesOverflow?: number
      /**
       * Что инструмент сделал на самом деле — из разобранного результата
       * (`tool_use_result`), а не из текста, ушедшего модели: прервано по
       * таймауту, прочитана часть файла, показаны не все совпадения.
       */
      facts?: import('./toolFacts').ToolFact[]
    }
  /**
   * Сердцебиение идущего вызова: движок подтверждает, что инструмент ещё жив.
   *
   * Наш секундомер идёт одинаково у работающей команды и у повисшей — «идёт 4
   * минуты» и «висит 4 минуты» на экране неразличимы. Пульс различает их, но
   * только там, где он есть: SDK не обещает слать его для каждого инструмента,
   * и по молчанию с самого начала объявлять смерть нельзя (см. @shared/toolPulse).
   */
  | {
      type: 'tool_pulse'
      toolUseId: string
      /** Сколько вызов идёт по часам движка, секунд. */
      elapsedSec: number
      /** Движок повторяет упавшую подзадачу — попытка из скольких. */
      retry?: { attempt: number; max: number }
    }
  | {
      type: 'permission'
      toolUseId: string
      toolName: string
      input: unknown
      title?: string
      displayName?: string
      /** Present when toolName === 'AskUserQuestion' — the choice widget payload. */
      questions?: AgentQuestion[]
      /**
       * Агент предлагает только «разрешить всегда» — разового варианта у этого
       * гейта нет. Кнопка обязана сказать это словом: одобрение здесь действует
       * до конца сессии, а не на один запуск.
       */
      allowAlwaysOnly?: boolean
      /**
       * Гейт показан НЕСМОТРЯ на включённый автопилот: команда необратима.
       * Окно обязано назвать причину — иначе вопрос при снятом гейте выглядит
       * поломкой тумблера, а не защитой от потери работы.
       */
      irreversible?: { kind: string; hit: string }
      /**
       * Чем ПОМЕТИЛ этот инструмент сам сервер (MCP-аннотации). Не наша
       * проверка и не обещание: сервер вправе не заполнить пометки вовсе.
       * Поэтому отсутствие пометки ничего не значит, а показывать её надо с
       * указанием источника — «сервер помечает».
       */
      mcpMark?: import('./mcp').McpMark
    }
  /**
   * Пометка приехала позже своей карточки.
   *
   * Карту пометок спрашивают у движка один раз на сессию, и самый первый
   * MCP-гейт может её опередить. Ждать карту, придерживая карточку, нельзя:
   * человеку она нужна сразу. Поэтому пометка досылается — гейт всё равно ждёт
   * решения, и она успевает к тому моменту, когда её читают.
   */
  | { type: 'tool-mark'; toolUseId: string; mcpMark: import('./mcp').McpMark }
  | {
      type: 'result'
      isError: boolean
      result?: string
      costUsd?: number
      numTurns?: number
      sessionId?: string
      /** Model ids actually used this turn (keys of modelUsage) — ground truth. */
      models?: string[]
      /** Сколько ход шёл целиком, мс — движок считает сам. */
      durationMs?: number
      /** Через сколько пошёл первый токен, мс: «думает» отличимо от «висит». */
      ttftMs?: number
      /**
       * Чем ход кончился, словами движка (`TerminalReason` + `subtype` итога).
       * «Ошибка» одним словом на лимит ходов, потолок трат и отказ модели —
       * три разные новости, слитые в одну.
       */
      endReason?: string
      /** Сколько вызовов отклонено без вопроса за этот ход. */
      denials?: number
    }
  | { type: 'error'; message: string }

/**
 * Здоровье движка: что запускается, откуда и что он сам о себе говорит.
 *
 * Когда Claude Code сломан, Заря выглядит сломанной. Этот снимок отвечает на
 * два вопроса, ответа на которые нигде не было: КАКОЙ файл работает (их в
 * системе бывает несколько) и что о себе думает сам движок.
 */
export interface AgentEngineBinary {
  path: string
  /** «2.1.226». Пусто — файл есть, а версию узнать не вышло. */
  version?: string
  /** `bundled` — приехал с Зарёй, `system` — свой у человека, `env` — задан переменной. */
  origin: 'bundled' | 'system' | 'env'
  chosen: boolean
}

export interface AgentEngineHealth {
  binaries: AgentEngineBinary[]
  /**
   * Кто вошёл в движок. `null` — он не ответил.
   *
   * «Вошли не тем аккаунтом» — самая обидная из причин, по которым агент
   * отвечает не то: снаружи она неотличима от плохой модели. Полей четыре из
   * семи: идентификатор организации на этот вопрос не отвечает, а экран
   * настроек попадает на скриншоты.
   */
  auth?: { loggedIn: boolean; method?: string; email?: string; plan?: string } | null
  /**
   * Почему выбран этот. КЛЮЧ словаря, а не фраза: причина решается в главном
   * процессе, а говорит о ней окно — и на своём языке.
   */
  reason: string
  /**
   * Отчёт движка о себе, ДОСЛОВНО. Приходит только по нажатию: это запуск
   * процесса на несколько секунд. Своего вердикта поверх не ставим — отчёт
   * внутренне противоречив (печатает находку и следом «проблем нет»), и свести
   * его в одно наше слово значило бы выбрать, какой из двух его фраз верить.
   */
  doctor?: { ok: true; text: string } | { ok: false; error: string }
}

/** SDK effort levels (mirrors the Agent SDK's EffortLevel — future-proof). */
export type AgentEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A model as reported dynamically by a driver (e.g. query.supportedModels()). */
export interface AgentModelInfo {
  /** Model id / alias to pass to the driver (e.g. 'opus', 'claude-sonnet-5'). */
  value: string
  /** Canonical wire id this resolves to. */
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: AgentEffortLevel[]
}

/** A past agent session on disk (for the resume picker), scoped by folder. */
export interface AgentSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  firstPrompt?: string
  gitBranch?: string
}

/** Renderer -> main decision resolving a pending canUseTool permission (allow/deny a tool). */
export type AgentPermissionDecision =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      /**
       * Человек осознанно согласился на постоянное разрешение: ему показали, что
       * у этого гейта нет разового варианта, и он нажал именно такую кнопку. Без
       * этого флага драйвер НИКОГДА не выбирает «разрешить всегда» — иначе
       * разовое «ВЫПОЛНИТЬ» тихо превращалось бы в разрешение на всю сессию.
       */
      always?: boolean
    }
  | { behavior: 'deny'; message: string }

/**
 * Renderer -> main answer to a structured AskUserQuestion-style prompt. Generic
 * across drivers: keyed by the question text, value = chosen option label(s).
 * Each driver maps this onto its wire shape (Claude: updatedInput {questions,
 * answers}; Gemini ask_user: {outcome:'selected', optionId}).
 */
export interface AgentQuestionAnswer {
  answers: Record<string, string[]>
}

/**
 * What a driver instance can do, so the UI conditionally renders controls
 * (fuel gauge, effort dial, resume picker, bypass chip, model picker, question
 * widget) instead of hardcoding `engine === 'claude-code'`.
 */
export interface AgentCapabilities {
  /** listModels()/setModel() are meaningful. */
  models: boolean
  /** listModels() works WITHOUT a live session (Codex model/list) vs needs one (Claude). */
  modelsWithoutSession: boolean
  /** setEffort() is meaningful (a reasoning-effort dial exists). */
  effort: boolean
  /** An auto-approve-all-tools "без спроса" mode exists. */
  bypass: boolean
  /** listSessions()/loadSessionMessages()/opts.resume are meaningful. */
  resumableSessions: boolean
  /** A subscription/quota usage gauge exists (Claude only today). */
  usage: boolean
  /** The driver can emit a 'permission' event carrying `questions` (AskUserQuestion-style). */
  structuredQuestions: boolean
  /**
   * Движок принимает изображения. Где false — вставка не должна создавать
   * вложение: проглотить картинку и отправить запрос без неё значит соврать.
   */
  images?: boolean
  /**
   * Движок умеет отматывать отправленное сообщение из контекста (Esc над ходом,
   * на который агент ещё не ответил) — см. {@link AgentRewind}. Возможность, а
   * не обещание: удастся ли конкретная отмена, отвечает сам драйвер. Где false,
   * сообщение остаётся в ленте с пометкой «прервано» — прятать его нельзя,
   * агент его помнит.
   */
  rewind?: boolean
  /**
   * Движок называет состав своих инструментов: MCP-серверы, их состояние и цену
   * в контексте (см. {@link McpSnapshot}). Где false — вкладка «Инструменты»
   * говорит «этот движок так не умеет». Показать вместо этого пустой список
   * значило бы сказать «серверов нет», а это другая мысль.
   */
  mcp?: boolean
  /**
   * Движок умеет остановить ОДНУ задачу, не обрывая ход.
   *
   * Без этого у человека, увидевшего, что субагент десять минут жжёт токены не
   * туда, был ровно один рычаг — Esc, то есть отмена всей работы разом. Где
   * false, кнопки в волне нет вовсе: показать её и не смочь остановить — хуже,
   * чем не показывать.
   */
  stopTask?: boolean
  /**
   * Движок умеет возвращать ФАЙЛЫ к состоянию на выбранном ходе.
   *
   * Отдельный флаг, а не `rewind`: тот про откат РАЗГОВОРА (resumeSessionAt +
   * forkSession) и есть у движков, которые про файлы ничего не умеют. Одно имя
   * на два разных умения означало бы кнопку отката файлов там, где её нечем
   * выполнить.
   */
  rewindFiles?: boolean
  /**
   * Движку можно добавить рабочую папку сверх `cwd`.
   *
   * Где false — кнопки «добавить папку» нет вовсе. Показать её у движка,
   * который папку проигнорирует, значит выдать разрешение, которого не будет:
   * человек решит, что дал доступ, а агент по-прежнему получит отказ.
   */
  directories?: boolean
  /**
   * Движок может рассказать о себе: какой файл работает, какая версия, что у
   * него сломано. Где false — раздела «Движок» нет вовсе: пустой экран
   * диагностики сам выглядит как поломка.
   */
  health?: boolean
  /**
   * Движок понимает режим плана: сперва рассказать, что собирается сделать, и
   * ничего не трогать до согласия.
   *
   * Где false — чипа нет. Показать переключатель, который движок пропустит
   * мимо ушей, значит пообещать осторожность, которой не будет.
   */
  planMode?: boolean
  /** Extra named toggles beyond the common set (e.g. Claude's 'ultracode'); UI renders generically. */
  vendorFlags?: { key: string; label: string; desc?: string }[]
}

/**
 * MCP-сервер в том виде, в каком его МОЖНО показать человеку.
 *
 * Урезано намеренно. У SDK в `McpServerStatus.config` лежат `env` (stdio) и
 * `headers` (http/sse) — то есть ключи и токены. Строку собирает главный
 * процесс и отдаёт только её: секрет не пересекает IPC вообще. «Оно в
 * рендерере, но мы его не рисуем» — не защита, а обещание не смотреть, и
 * первый же дамп памяти или открытый DevTools это обещание отменяет.
 */
export interface McpServerRow {
  name: string
  /** Состояние ровно как его назвал движок — без наших догадок. */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  /** Причина отказа, дословно от движка. Пусто — причина не названа. */
  error?: string
  /** Как подключён: stdio, http, sse, ws, sdk. */
  transport?: string
  /** Хост (для сетевых) или имя команды (для локальных). Без query и заголовков. */
  origin?: string
  /** Откуда конфиг: project, user, local, claudeai, managed. */
  scope?: string
  /** Версия сервера — есть только у подключённых. */
  version?: string
  /** Сколько инструментов сервер отдал. */
  tools?: number
  /** Во сколько эти инструменты обходятся в КАЖДОМ запросе. Считает движок. */
  tokens?: number
}

/**
 * Состав инструментов ОДНОЙ беседы.
 *
 * Именно одной: `.mcp.json` живёт в папке проекта, а окно контекста — у
 * конкретной сессии. Две панели в разных репозиториях видят разные наборы, и
 * снимок обязан называть, чей он.
 */
export interface McpSnapshot {
  /** Движок не умеет — окно скажет словами, а не покажет пустоту. */
  unsupported?: boolean
  /** Живой беседы нет: это прошлый снимок, свежий — по кнопке. */
  stale?: boolean
  /** Когда снят, мс. Без этого «прошлый снимок» неотличим от свежего. */
  at?: number
  servers: McpServerRow[]
  /** Занято в окне и потолок окна — цифры движка, своей арифметики не изобретаем. */
  contextTokens?: number
  contextMax?: number
  /**
   * Чем именно занято окно.
   *
   * Число «занято» отвечает на «много ли», а человек следом спрашивает «а чем?».
   * Движок разбор считает — до сих пор мы его выбрасывали. Отложенные статьи
   * помечены: они в контексте НЕ лежат, и складывать их с занятым нельзя (см.
   * @shared/contextParts).
   */
  contextParts?: import('./contextParts').ContextPart[]
  /**
   * Файлы памяти в контексте: чей и почём.
   *
   * Самая частая неожиданность из всего разбора — личный CLAUDE.md, который
   * молча стоит несколько тысяч токенов в КАЖДОМ запросе. Пока его цену никто
   * не называл, узнать о ней было неоткуда.
   */
  memoryFiles?: { path: string; kind: string; tokens: number }[]
  /**
   * Скиллы этой беседы и их цена.
   *
   * Тело скилла грузится, только когда он понадобился, а вот его описание лежит
   * в контексте ВСЕГДА — иначе агент не знал бы, что скилл существует. У
   * человека с полусотней скиллов это заметные деньги в каждом запросе, и до
   * сих пор их никто не показывал: движок считает, мы выбрасывали.
   */
  skills?: McpSkills
}

/** Сколько скиллов подключено и во сколько обходится каждый. */
export interface McpSkills {
  total: number
  /** Сколько из них реально попало в контекст (остальные отфильтрованы). */
  included: number
  tokens: number
  items: SkillRow[]
}

/**
 * Состояния скилла из `skillOverrides` Claude Code.
 *
 * Названия — движка, не наши: в файл человека попадёт ровно то, что понимает
 * CLI. Своего пятого состояния Заря не придумывает.
 */
export type SkillState = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/** Слои настроек Claude Code — личные, проекта и локальные проекта. */
export type SkillLayer = 'user' | 'project' | 'local'

export interface SkillRow {
  name: string
  source: string
  tokens: number
  /** Эффективное состояние с учётом всех слоёв. */
  state: SkillState
  /**
   * Каким слоем задано, если задано не нами.
   *
   * Заря пишет в личный слой, а настройки проекта его перебивают. Знать, что
   * ключ перекрыт сверху, обязательно: иначе переключатель «сработает» и ничего
   * не изменит — ровно та кнопка, которая врёт.
   */
  from?: SkillLayer
}

/** Что нашлось на диске, когда живую беседу попросили перечитать скиллы и MCP. */
export interface AgentExtrasReload {
  ok: boolean
  /** Движок так не умеет — не путать с «ничего не нашлось». */
  unsupported?: boolean
  commands: import('./agentCommands').AgentCommand[]
  plugins: number
  mcpServers: { name: string; status?: string }[]
  errors: number
}

// --- Back-compat aliases (Claude Code was the first driver). Remove after inc-9. ---
export type ClaudeCliQuestion = AgentQuestion
export type ClaudePermissionMode = AgentPermissionMode
export type ClaudeStartOpts = AgentStartOpts
export type ClaudeUsage = AgentUsage
export type ClaudeStreamEvent = AgentStreamEvent
export type ClaudeEffortLevel = AgentEffortLevel
export type ClaudeModelInfo = AgentModelInfo
export type ClaudeSessionInfo = AgentSessionInfo
export type ClaudePermissionDecision = AgentPermissionDecision

// ---------------------------------------------------------------------------
// Global command history (Time Machine)
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string
  command: string
  cwd: string
  sessionId: string
  shellName: string
  exitCode?: number
  at: number
}

// ---------------------------------------------------------------------------
// Workflows (parameterized command snippets)
// ---------------------------------------------------------------------------

export interface WorkflowParam {
  name: string
  description?: string
  default?: string
}

export interface WorkflowDef {
  id: string
  name: string
  description?: string
  /** Command template with {{param}} placeholders. */
  command: string
  params: WorkflowParam[]
  tags: string[]
  /** True for the bundled starter pack (read-only). */
  builtin?: boolean
}

// ---------------------------------------------------------------------------
// Filesystem / git (IDE features)
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

export interface FileContent {
  path: string
  content: string
  truncated: boolean
  binary: boolean
  size: number
}

export interface GitFileStatus {
  path: string
  /** Two-letter porcelain status, e.g. " M", "??", "A ". */
  status: string
}

export interface GitStatus {
  root: string
  branch: string
  ahead: number
  behind: number
  dirty: number
  files: GitFileStatus[]
}

export interface GitDiff {
  path: string
  /** Content at HEAD ('' for new files). */
  original: string
  /** Current working-tree content. */
  modified: string
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export interface ThemeTerminalColors {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeUiColors {
  bg: string
  bgElev1: string
  bgElev2: string
  panel: string
  border: string
  borderStrong: string
  fg: string
  fgDim: string
  fgFaint: string
  accent: string
  accent2: string
  /** CSS gradient used for signature highlights (tabs, buttons, logo). */
  accentGradient: string
  danger: string
  success: string
  warn: string
}

export interface ThemeDef {
  id: string
  /** Ключ подписи: имя темы рисуется на языке интерфейса. */
  nameKey: string
  type: 'dark' | 'light'
  ui: ThemeUiColors
  terminal: ThemeTerminalColors
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  electron: string
  chrome: string
  node: string
  userDataPath: string
}

export type WindowCommand = 'minimize' | 'maximize' | 'close' | 'devtools'

/** Payload sent by main when it wants renderer to snapshot everything before quit. */
export interface PrepareQuitPayload {
  reason: 'quit' | 'close'
}

/**
 * Тип данных перетаскивания «проект → панель». Свой, а не text/plain: файлы
 * обрабатывает строка ввода, и пути не должны путаться с вложениями.
 */
export const PANE_DRAG_CWD = 'application/x-zarya-cwd'

/** Перетаскивание УЖЕ ОТКРЫТОГО терминала: переносим панель, а не создаём новую. */
export const PANE_DRAG_SESSION = 'application/x-zarya-session'
