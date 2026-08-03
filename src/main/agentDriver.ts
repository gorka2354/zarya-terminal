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
  listCommands?(): Promise<import('@shared/agentCommands').AgentCommand[]>
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
   * Перечитать скиллы, плагины и MCP, не перезапуская беседу.
   *
   * Раньше вызывалось из ipc кастом мимо этого интерфейса — а `capabilities`
   * существует ровно для того, чтобы окно знало, что движок умеет, без
   * догадок по типу.
   */
  reloadExtras?(): Promise<AgentExtrasReload>
  setModel?(requestId: string, model: string | undefined): void
  setEffort?(requestId: string, effort: string | undefined): void
  setBypass?(requestId: string, bypass: boolean): void
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
