import type {
  AgentCapabilities,
  AgentEngine,
  AgentExtrasReload,
  AgentModelInfo,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentSessionInfo,
  AgentStartOpts,
  AiMessage,
  McpSnapshot
} from '@shared/types'

/**
 * The driver-agnostic contract every native agent backend implements
 * (Claude Code today; Codex via `codex app-server`, Gemini via `gemini --acp`
 * in inc-10/11). The IPC layer routes renderer calls to a driver picked from a
 * `Map<AgentEngine, AgentDriver>` registry by `engine`; the renderer reads
 * {@link AgentCapabilities} to decide which controls to render, instead of
 * hardcoding `engine === 'claude-code'`.
 *
 * Stream events are NOT returned from these methods — a driver emits
 * {@link AgentStreamEvent}s to the renderer itself (via the window it was
 * constructed with), tagged by `requestId` (== the conversation id).
 *
 * ## Process lifecycle (inc-9 decision: "driver owns the process")
 * A driver owns its backend process lifecycle. Claude spawns per-query via the
 * Agent SDK; Codex/Gemini keep ONE long-lived child (`app-server` / `--acp`)
 * per engine, multiplexing conversations by an internal thread/session id the
 * driver maps from `requestId`. `killAll()` MUST terminate every owned child;
 * the main process calls it on EVERY teardown path (did-navigate,
 * window-all-closed, before-quit, requestQuitConfirmed) via the registry.
 */
export interface AgentDriver {
  /** Which engine this driver backs (registry key). */
  readonly engine: AgentEngine
  /** What this driver can do — drives conditional UI in the renderer. */
  readonly capabilities: AgentCapabilities

  /** Start (or follow-up on) a turn. First call for a requestId spawns/opens the session. */
  start(requestId: string, opts: AgentStartOpts): Promise<void>
  /** Enqueue a follow-up user message on a live session. */
  input(requestId: string, text: string): void
  /** Abort the in-flight turn. */
  interrupt(requestId: string): void
  /** Resolve a pending tool-permission gate (allow/deny). */
  resolvePermission(requestId: string, toolUseId: string, decision: AgentPermissionDecision): void
  /** Terminate all owned backend processes/sessions. Called on every quit path. */
  killAll(): void

  // --- Optional per-capability surface (guarded by `capabilities`). ---
  /** Answer a structured AskUserQuestion-style prompt (gated by capabilities.structuredQuestions). */
  resolveQuestion?(requestId: string, toolUseId: string, answer: AgentQuestionAnswer): void
  listSessions?(cwd: string | undefined): Promise<AgentSessionInfo[]>
  loadSessionMessages?(sessionId: string, cwd: string | undefined): Promise<AiMessage[]>
  listModels?(): Promise<AgentModelInfo[]>
  /**
   * Команды движка («/review», «/plan»…) — то, что человек набирает через слэш.
   *
   * Необязательный: движок, который своих команд не называет, не должен
   * притворяться, что их нет. Отсутствие метода и пустой список — разные вещи,
   * и окно скажет об этом разными словами.
   */
  listCommands?(
    requestId?: string
  ): Promise<import('@shared/agentCommands').AgentCommand[]>
  /**
   * В какой папке работает беседа.
   *
   * Нужно не самой беседе, а наблюдателю за скиллами и MCP: `.mcp.json` и
   * `.claude/skills` лежат в проекте, поэтому следить надо за папками ПАНЕЛЕЙ,
   * а не за папкой, из которой запустили приложение.
   */
  sessionCwd?(requestId: string): string | undefined
  /**
   * Состав и здоровье MCP-серверов ОДНОЙ беседы (гейт: `capabilities.mcp`).
   *
   * Беседа названа не для красоты: `.mcp.json` лежит в папке проекта, а окно
   * контекста принадлежит сессии. «Инструменты вообще» не существует — две
   * панели в разных репозиториях видят разные наборы. Если беседа не названа
   * или уже закрыта, драйвер отдаёт прошлый снимок с пометкой `stale`, но
   * никогда не выдаёт набор чужой панели за её.
   *
   * `probe: true` разрешает поднять движок ради ответа, когда живой беседы
   * нет. По умолчанию нельзя: проверка связи ЗАПУСКАЕТ серверы по-настоящему,
   * то есть чужие процессы (`uvx`, `npx`, `uv run`) и секунды ожидания. Это
   * делается только по нажатию человека.
   */
  mcpStatus?(requestId: string | undefined, opts?: { probe?: boolean }): Promise<McpSnapshot>
  /**
   * Остановить ОДНУ задачу, не обрывая ход (гейт: `capabilities.stopTask`).
   *
   * До этого у человека был один рычаг — Esc, обрывающий работу целиком. Видя,
   * что субагент ушёл не туда, он платил за это всей остальной волной.
   *
   * Успех тут — не «мы попросили», а `task_notification` со статусом
   * `stopped`, который придёт следом: только он означает, что задача и правда
   * встала. Поэтому метод отвечает лишь на вопрос «просьба ушла».
   */
  stopTask?(
    requestId: string,
    taskId: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }>
  /**
   * Принять новый состав рабочих папок беседы (гейт: `capabilities.directories`).
   *
   * Папки — опция ЗАПУСКА, а живая сессия переживает все ходы беседы. Драйвер
   * сам решает, как их применить: Claude Code закрывает сессию, и следующий ход
   * поднимает её заново с теми же папками и тем же контекстом (`resume`).
   *
   * Сам список драйверу не передаём: он придёт со следующим `start`. Это метод
   * «прими к сведению», а не «вот тебе значение», — иначе состав жил бы в двух
   * местах и рано или поздно разошёлся бы.
   */
  applyDirectories?(requestId: string): { ok: boolean; reason?: 'busy' | 'no-session' }
  /**
   * Здоровье движка (гейт: `capabilities.health`).
   *
   * Не про беседу, а про сам движок: какой исполняемый файл работает, какие ещё
   * нашлись и что он говорит о себе сам. Живой сессии не требует — иначе
   * диагноз был бы недоступен ровно тогда, когда он нужен: когда ничего не
   * запускается.
   *
   * `doctor: true` разрешает СПРОСИТЬ движок о нём самом. По умолчанию нельзя:
   * это чужой процесс на несколько секунд, и запускается он только с нажатия.
   */
  engineHealth?(opts?: {
    cwd?: string
    doctor?: boolean
  }): Promise<import('@shared/types').AgentEngineHealth>
  /** Переподключить один сервер живой беседы. */
  mcpReconnect?(
    requestId: string,
    name: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }>
  /**
   * Включить или выключить сервер живой беседы.
   *
   * Пишет в конфиг ДВИЖКА (`~/.claude.json`), а не в наш, и делает это для
   * текущего проекта. Окно обязано сказать это словами: человек должен знать,
   * чей файл меняет Заря.
   */
  mcpToggle?(
    requestId: string,
    name: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }>
  /**
   * Переключить состояние скилла в настройках движка.
   *
   * Пишет в личные настройки Claude Code (`~/.claude/settings.json`), ключ
   * `skillOverrides`. Отказывается, если тот же ключ задан настройками проекта:
   * они сильнее, и запись прошла бы «успешно», ничего не изменив.
   */
  skillOverride?(
    requestId: string | undefined,
    name: string,
    state: import('@shared/types').SkillState
  ): Promise<{
    ok: boolean
    error?: string
    /** `unreadable` — файл настроек есть, но не читается: писать поверх нельзя. */
    reason?: 'overridden' | 'unreadable'
    by?: import('@shared/types').SkillLayer
  }>
  /**
   * Перечитать скиллы, плагины и MCP, не перезапуская беседу.
   *
   * Раньше вызывалось из ipc кастом мимо этого интерфейса — а `capabilities`
   * существует ровно для того, чтобы окно знало, что движок умеет, без
   * догадок по типу.
   */
  reloadExtras?(requestId?: string): Promise<AgentExtrasReload>
  setModel?(requestId: string, model: string | undefined): void
  setEffort?(requestId: string, effort: string | undefined): void
  setBypass?(requestId: string, bypass: boolean): void
  /**
   * Сменить режим разрешений живой сессии (гейт: `capabilities.planMode`).
   *
   * Допущены только `plan` и `default` — режимы, которые гейт НЕ ослабляют.
   * Главный процесс проверяет это отдельно: драйвер здесь — не единственная
   * защита, а последняя.
   */
  setPermissionMode?(requestId: string, mode: 'plan' | 'default'): void
  /** Generalizes vendor toggles (e.g. Claude's 'ultracode'). */
  setVendorFlag?(requestId: string, key: string, value: unknown): void
  /** QA only — the flag payloads last applied to a session's live backend. */
  debugFlags?(requestId?: string): Record<string, unknown> | Promise<Record<string, unknown>>
  /**
   * Is this driver's backend installed/runnable? When present and it resolves
   * false, the engine is hidden from `agent:capabilities` (no dead chip). Absent
   * ⇒ always available (Claude Code, bundled fakes).
   */
  probe?(): Promise<boolean>
}
