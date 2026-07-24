import type {
  AgentCapabilities,
  AgentEngine,
  AgentModelInfo,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentSessionInfo,
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
  }
  /** Generic native-agent transport — every call carries `engine` (registry key). */
  agent: {
    capabilities(): Promise<Record<AgentEngine, AgentCapabilities>>
    start(engine: AgentEngine, requestId: string, opts: AgentStartOpts): void
    input(engine: AgentEngine, requestId: string, text: string): void
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
  }
  workflows: {
    list(): Promise<WorkflowDef[]>
    save(wf: WorkflowDef): Promise<void>
    delete(id: string): Promise<void>
  }
  app: {
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
