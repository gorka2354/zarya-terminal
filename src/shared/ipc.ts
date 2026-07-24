/** IPC channel names. Single source of truth — used by main, preload and typings. */
export const CH = {
  // pty
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data', // main -> renderer
  ptyExit: 'pty:exit', // main -> renderer

  // sessions
  sessionsList: 'sessions:list',
  sessionsSaveSnapshot: 'sessions:save-snapshot',
  sessionsLoadSnapshot: 'sessions:load-snapshot',
  sessionsDelete: 'sessions:delete',
  sessionsSetFlag: 'sessions:set-flag',
  sessionsRename: 'sessions:rename',
  sessionsSaveWorkspace: 'sessions:save-workspace',
  sessionsLoadWorkspace: 'sessions:load-workspace',
  aiConversationsSave: 'ai-conversations:save',
  aiConversationsLoad: 'ai-conversations:load',
  prepareQuit: 'app:prepare-quit', // main -> renderer
  readyToQuit: 'app:ready-to-quit', // renderer -> main

  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed', // main -> renderer
  settingsSetSecret: 'settings:set-secret',
  settingsProviderStatus: 'settings:provider-status',

  // shells
  shellsDetect: 'shells:detect',

  // ai clis
  aiClisDetect: 'ai-clis:detect',

  // ai
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  aiStream: 'ai:stream', // main -> renderer
  aiOllamaModels: 'ai:ollama-models',

  // native agent drivers (claude-code, codex, gemini). Renderer->main calls carry
  // `engine` as the first arg so the main handler routes to the registry driver.
  agentCapabilities: 'agent:capabilities', // engine -> AgentCapabilities map (for UI gating)
  agentStart: 'agent:start',
  agentInput: 'agent:input',
  agentInterrupt: 'agent:interrupt',
  agentPermission: 'agent:permission',
  agentQuestion: 'agent:question', // resolve a structured AskUserQuestion-style prompt
  agentStream: 'agent:stream', // main -> renderer, payload carries `engine`
  agentListSessions: 'agent:list-sessions',
  agentSessionMessages: 'agent:session-messages',
  agentSetModel: 'agent:set-model',
  agentSetBypass: 'agent:set-bypass',
  agentSetEffort: 'agent:set-effort',
  agentSetVendorFlag: 'agent:set-vendor-flag', // generalizes set-ultracode
  agentListModels: 'agent:list-models',
  agentDebugFlags: 'agent:debug-flags',

  // fs / git
  fsReadDir: 'fs:read-dir',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsStat: 'fs:stat',
  fsCreate: 'fs:create',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',
  gitStatus: 'git:status',
  gitDiffFile: 'git:diff-file',

  // history
  historyAdd: 'history:add',
  historySearch: 'history:search',

  // workflows
  workflowsList: 'workflows:list',
  workflowsSave: 'workflows:save',
  workflowsDelete: 'workflows:delete',

  // app / window
  appInfo: 'app:info',
  windowCommand: 'window:command',
  windowMaximized: 'window:maximized', // main -> renderer
  openExternal: 'app:open-external',
  showItemInFolder: 'app:show-item-in-folder',
  pickDirectory: 'app:pick-directory',
  setOpacity: 'app:set-opacity'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
