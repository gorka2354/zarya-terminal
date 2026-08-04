import type { UpdateState } from '../shared/updates'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentModelInfo,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentSessionInfo,
  AgentRewind,
  AgentStartOpts,
  AgentStreamEvent,
  AiChatRequest,
  AiCli,
  AiConversationsState,
  AiMessage,
  AiProviderKind,
  AiProviderStatus,
  AiStreamEvent,
  ClaudeModelInfo,
  ClaudePermissionDecision,
  ClaudeSessionInfo,
  ClaudeStartOpts,
  ClaudeStreamEvent,
  AppInfo,
  DirEntry,
  FileContent,
  GitDiff,
  GitStatus,
  HistoryEntry,
  PrepareQuitPayload,
  PtySpawnRequest,
  PtySpawnResult,
  SessionMeta,
  SessionSnapshot,
  Settings,
  ShellProfile,
  WindowCommand,
  WorkflowDef,
  WorkspaceState
} from '../shared/types'

type Unsub = () => void

export interface ZaryaApi {
  pty: {
    spawn(req: PtySpawnRequest): Promise<PtySpawnResult>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    kill(sessionId: string): void
    onData(cb: (sessionId: string, data: string) => void): Unsub
    onExit(cb: (sessionId: string, exitCode: number) => void): Unsub
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    saveSnapshot(snap: SessionSnapshot): Promise<void>
    loadSnapshot(id: string): Promise<SessionSnapshot | null>
    delete(id: string): Promise<void>
    setFlag(id: string, flag: 'pinned' | 'favorite', value: boolean): Promise<void>
    rename(id: string, title: string): Promise<void>
    saveWorkspace(ws: WorkspaceState): Promise<void>
    loadWorkspace(): Promise<WorkspaceState | null>
    onPrepareQuit(cb: (p: PrepareQuitPayload) => void): Unsub
    readyToQuit(): void
  }
  aiConversations: {
    save(state: AiConversationsState): Promise<void>
    load(): Promise<AiConversationsState | null>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChange(cb: (s: Settings) => void): Unsub
    setSecret(provider: AiProviderKind, key: string): Promise<void>
    providerStatus(): Promise<AiProviderStatus[]>
  }
  shells: {
    detect(): Promise<ShellProfile[]>
  }
  aiClis: {
    detect(): Promise<AiCli[]>
  }
  ai: {
    chat(requestId: string, req: AiChatRequest): void
    abort(requestId: string): void
    onStream(cb: (requestId: string, ev: AiStreamEvent) => void): Unsub
    listOllamaModels(baseUrl: string): Promise<string[]>
    /**
     * Каталог моделей провайдера: живой, с кешем. `at` — когда получен, `error`
     * стоит, если спросить не вышло и список пришёл из кеша.
     */
    listModels(
      provider: string
    ): Promise<{
      ids: string[]
      at: number
      error?: string
      /** Список из кеша: спросить не вышло, показывать его как свежий нельзя. */
      stale?: boolean
    }>
  }
  /** Generic native-agent transport — every call carries `engine` (registry key). */
  agent: {
    capabilities(): Promise<Record<AgentEngine, AgentCapabilities>>
    start(engine: AgentEngine, requestId: string, opts: AgentStartOpts): void
    input(engine: AgentEngine, requestId: string, text: string): void
    /**
     * Отменить отправленное сообщение: прервать ход и сказать, откуда продолжать.
     * Точка ветки — сообщение из контекста уйдёт; null — движок так не умеет,
     * убирать его из ленты нельзя.
     */
    rewind(engine: AgentEngine, requestId: string): Promise<AgentRewind | null>
    interrupt(engine: AgentEngine, requestId: string): void
    permission(
      engine: AgentEngine,
      requestId: string,
      toolUseId: string,
      decision: AgentPermissionDecision
    ): void
    question(
      engine: AgentEngine,
      requestId: string,
      toolUseId: string,
      answer: AgentQuestionAnswer
    ): void
    onStream(cb: (requestId: string, engine: AgentEngine, ev: AgentStreamEvent) => void): Unsub
    listSessions(engine: AgentEngine, cwd: string | undefined): Promise<AgentSessionInfo[]>
    sessionMessages(
      engine: AgentEngine,
      sessionId: string,
      cwd: string | undefined
    ): Promise<AiMessage[]>
    setModel(engine: AgentEngine, requestId: string, model: string | undefined): void
    setBypass(engine: AgentEngine, requestId: string, bypass: boolean): void
    setEffort(engine: AgentEngine, requestId: string, effort: string | undefined): void
    setVendorFlag(engine: AgentEngine, requestId: string, key: string, value: unknown): void
    listModels(engine: AgentEngine): Promise<AgentModelInfo[]>
    /**
     * Команды движка для палитры «/» — из ЭТОЙ беседы: проектные скиллы лежат
     * рядом с кодом, поэтому у панелей в разных репозиториях списки разные.
     */
    listCommands(
      engine: AgentEngine,
      requestId?: string
    ): Promise<{
      commands: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[] }>
      source: 'engine' | 'unknown'
      note?: string
    }>
    /** Перечитать скиллы/плагины/MCP ЭТОЙ беседы, не перезапуская её. */
    reloadExtras(engine: AgentEngine, requestId?: string): Promise<{
      ok: boolean
      unsupported?: boolean
      commands?: Array<{ name: string; description: string; argumentHint?: string }>
      plugins?: number
      mcpServers?: Array<{ name: string; status?: string }>
      errors?: number
    }>
    /** На диске появились новые скиллы/плагины/MCP. */
    onExtrasChanged(cb: () => void): Unsub
    /**
     * Состав и здоровье MCP-серверов ОДНОЙ беседы.
     *
     * `probe` разрешает поднять движок, когда живой беседы нет, — передаётся
     * только по нажатию «Проверить»: health-check реально запускает серверы.
     */
    mcpStatus(
      engine: AgentEngine,
      requestId: string | undefined,
      probe?: boolean
    ): Promise<import('@shared/types').McpSnapshot>
    mcpReconnect(
      engine: AgentEngine,
      requestId: string,
      name: string
    ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }>
    mcpToggle(
      engine: AgentEngine,
      requestId: string,
      name: string,
      enabled: boolean
    ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }>
    skillOverride(
      engine: AgentEngine,
      requestId: string | undefined,
      name: string,
      state: import('@shared/types').SkillState
    ): Promise<{
      ok: boolean
      error?: string
      reason?: 'overridden' | 'unreadable'
      by?: import('@shared/types').SkillLayer
    }>
    skillUsed(names: string[]): void
    skillUsage(): Promise<import('@shared/skillUsage').SkillUsageSummary>
    skillUsageClear(): Promise<void>
    debugFlags(engine: AgentEngine, requestId?: string): Promise<Record<string, unknown>>
  }
  /** Back-compat shim over `agent` with engine 'claude-code'. Removed after inc-9 Ф3. */
  claudeCode: {
    start(requestId: string, opts: ClaudeStartOpts): void
    input(requestId: string, text: string): void
    interrupt(requestId: string): void
    permission(requestId: string, toolUseId: string, decision: ClaudePermissionDecision): void
    onStream(cb: (requestId: string, ev: ClaudeStreamEvent) => void): Unsub
    listSessions(cwd: string | undefined): Promise<ClaudeSessionInfo[]>
    sessionMessages(sessionId: string, cwd: string | undefined): Promise<AiMessage[]>
    setModel(requestId: string, model: string | undefined): void
    setBypass(requestId: string, bypass: boolean): void
    setEffort(requestId: string, effort: string | undefined): void
    setUltracode(requestId: string, on: boolean): void
    listModels(): Promise<ClaudeModelInfo[]>
    debugFlags(requestId?: string): Promise<Record<string, unknown>>
  }
  fs: {
    readDir(path: string): Promise<DirEntry[]>
    readFile(path: string): Promise<FileContent>
    writeFile(path: string, content: string): Promise<void>
    stat(path: string): Promise<{ exists: boolean; isDir: boolean; size: number } | null>
    create(path: string, isDir: boolean): Promise<void>
    rename(from: string, to: string): Promise<void>
    delete(path: string): Promise<void>
  }
  git: {
    status(cwd: string): Promise<GitStatus | null>
    diffFile(cwd: string, path: string): Promise<GitDiff | null>
  }
  history: {
    add(entry: HistoryEntry): Promise<void>
    search(query: string, limit?: number): Promise<HistoryEntry[]>
    /** Стереть историю целиком — и в памяти, и на диске. */
    clear(): Promise<{ ok: boolean }>
    /** Сколько записей и сколько весит файл — для строки в настройках. */
    stats(): Promise<{ entries: number; bytes: number }>
  }
  workflows: {
    list(): Promise<WorkflowDef[]>
    save(wf: WorkflowDef): Promise<void>
    delete(id: string): Promise<void>
  }
  /** Проверка обновлений: один анонимный запрос к GitHub, ничего не скачивается сам. */
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    /** Скачать обновление; прогресс приходит через onChange. */
    download(): Promise<UpdateState>
    /** Поставить скачанное и перезапуститься. */
    install(): Promise<{ ok: boolean; error?: string }>
    onChange(cb: (s: UpdateState) => void): Unsub
  }
  /** Local dictation — audio never leaves the machine. */
  stt: {
    state(): Promise<{
      modelReady: boolean
      /** Работаем на модели прошлых версий: без цифр, латиницы и пунктуации. */
      legacyModel?: boolean
      /** Что реально загружено в движок. */
      activeModelId?: string | null
      /** Список моделей для настроек. */
      models?: Array<{
        id: string
        labelKey: string
        lang: string
        license: string
        noteKey: string
        bytes: number
        installed: boolean
        legacy: boolean
        /** Своя модель: принесена с диска, а не скачана Зарёй. */
        custom?: boolean
        name?: string
        dir?: string
      }>
      engineReady: boolean
      downloading: { file: string; received: number; total: number } | null
      error?: string
    }>
    ensureModel(id?: string): Promise<{ ok: boolean; error?: string }>
    /** Убрать скачанную модель с диска. */
    removeModel(id: string): Promise<{ ok: boolean; error?: string }>
    /**
     * Добавить свою модель. Пути нет и не будет: папку выбирает человек в
     * системном диалоге, который открывает главный процесс.
     */
    addCustom(): Promise<{
      ok: boolean
      canceled?: boolean
      error?: string
      model?: { id: string; name: string }
    }>
    /** Убрать свою модель из списка. Файлы на диске остаются. */
    forgetCustom(id: string): Promise<{ ok: boolean }>
    onProgress(cb: (p: { file: string; received: number; total: number } | null) => void): Unsub
    transcribe(
      samples: Float32Array,
      sampleRate: number
    ): Promise<{ ok: boolean; text?: string; error?: string }>
  }
  app: {
    /** Позвать человека: агент встал, а окно не в фокусе. */
    notifyWaiting(title: string, body: string): void
    info(): Promise<AppInfo>
    windowCommand(cmd: WindowCommand): void
    onMaximized(cb: (maximized: boolean) => void): Unsub
    openExternal(url: string): void
    showItemInFolder(path: string): void
    pickDirectory(): Promise<string | null>
    getPathForFile(file: File): string
    setOpacity(value: number): void
  }
}

declare global {
  interface Window {
    zarya: ZaryaApi
  }
}

export {}
