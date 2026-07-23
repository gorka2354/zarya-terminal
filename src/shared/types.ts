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
}

export interface WorkspaceState {
  tabs: TabState[]
  activeTabId: string | null
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppearanceSettings {
  themeId: string
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
  /** Auto-approve agent command execution (dangerous, off by default). */
  autoApprove: boolean
  /** How many recent blocks to attach as context automatically. */
  contextBlocks: number
  /** Extra instructions appended to the system prompt. */
  systemPromptExtra: string
  /** Claude Code model override ('' = account default from ~/.claude). */
  claudeModel: string
  /** Claude Code effort override ('' = account default). */
  claudeEffort: string
  /** Auto-approve tool calls without prompting (canUseTool auto-allow; AskUserQuestion still surfaces). */
  claudeBypass: boolean
}

export interface SessionsSettings {
  restoreOnLaunch: 'workspace' | 'none'
  autosaveSec: number
  scrollbackSaveLines: number
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
  sessions: SessionsSettings
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
}

// ---------------------------------------------------------------------------
// AI transport (renderer builds requests; main process holds keys and streams)
// ---------------------------------------------------------------------------

export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface AiMessage {
  role: 'user' | 'assistant'
  content: AiContentPart[]
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
}

/** A conversation persisted to disk (survives restart), bound to a terminal + cwd. */
export interface PersistedConversation {
  id: string
  title: string
  engine: 'builtin' | 'claude-code'
  /** Terminal session this conversation belongs to. */
  sessionId?: string
  /** Claude Code session id — resumed on the next turn to keep full context. */
  claudeSessionId?: string
  /** Working directory the conversation was opened in. */
  cwd?: string
  messages: AiMessage[]
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
// Native Claude Code driver (headless Agent SDK, main process owns the child)
// ---------------------------------------------------------------------------

/** A single AskUserQuestion prompt (Claude's structured choice widget). */
export interface ClaudeCliQuestion {
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
 * process also whitelists this at the trust boundary.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface ClaudeStartOpts {
  /** The user's turn text. */
  prompt: string
  /** Working directory the agent operates in (the bound session's cwd). */
  cwd?: string
  /** Model id override; omit to use the CLI's configured default. */
  model?: string
  /** Reasoning effort override; omit to use the account default. */
  effort?: string
  permissionMode?: ClaudePermissionMode
  /** Auto-approve tool calls in canUseTool without prompting (AskUserQuestion still surfaces). */
  bypass?: boolean
  /** Ultracode: xhigh effort + standing dynamic-workflow orchestration (session-scoped). */
  ultracode?: boolean
  /** Resume a prior Claude Code session id (multi-turn continuity). */
  resume?: string
}

/**
 * Events streamed main -> renderer for a native Claude Code turn. Distinct from
 * {@link AiStreamEvent} (the built-in provider agent) so neither path perturbs
 * the other; the renderer adapter maps these onto the shared Conversation shape.
 */
/** Subscription rate-limit windows (utilization %, reset time) for the fuel gauge. */
export interface ClaudeUsage {
  subscriptionType?: string
  fiveHourPct?: number
  fiveHourResetsAt?: number
  sevenDayPct?: number
  sevenDayResetsAt?: number
}

export type ClaudeStreamEvent =
  | {
      type: 'init'
      sessionId: string
      model: string
      cwd: string
      permissionMode: string
      tools: string[]
      /** Reasoning effort from the account config (~/.claude/settings.json). */
      effort?: string
    }
  | { type: 'usage'; usage: ClaudeUsage }
  | { type: 'models'; models: ClaudeModelInfo[] }
  | { type: 'assistant'; content: AiContentPart[] }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
      type: 'permission'
      toolUseId: string
      toolName: string
      input: unknown
      title?: string
      displayName?: string
      /** Present when toolName === 'AskUserQuestion' — the choice widget payload. */
      questions?: ClaudeCliQuestion[]
    }
  | {
      type: 'result'
      isError: boolean
      result?: string
      costUsd?: number
      numTurns?: number
      sessionId?: string
      /** Model ids actually used this turn (keys of modelUsage) — ground truth. */
      models?: string[]
    }
  | { type: 'error'; message: string }

/** SDK effort levels (mirrors the Agent SDK's EffortLevel — future-proof). */
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A Claude model as reported dynamically by the SDK (query.supportedModels()). */
export interface ClaudeModelInfo {
  /** Model id / alias to pass to the SDK (e.g. 'opus', 'claude-sonnet-5'). */
  value: string
  /** Canonical wire id this resolves to. */
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: ClaudeEffortLevel[]
}

/** A past Claude Code session on disk (for the resume picker), scoped by folder. */
export interface ClaudeSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  firstPrompt?: string
  gitBranch?: string
}

/** Renderer -> main decision resolving a pending canUseTool permission. */
export type ClaudePermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

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
  name: string
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
