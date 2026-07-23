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

  // claude code native driver
  claudeCodeStart: 'claude-code:start',
  claudeCodeInput: 'claude-code:input',
  claudeCodeInterrupt: 'claude-code:interrupt',
  claudeCodePermission: 'claude-code:permission',
  claudeCodeStream: 'claude-code:stream', // main -> renderer
  claudeCodeListSessions: 'claude-code:list-sessions',
  claudeCodeSessionMessages: 'claude-code:session-messages',
  claudeCodeSetModel: 'claude-code:set-model',
  claudeCodeSetBypass: 'claude-code:set-bypass',
  claudeCodeSetEffort: 'claude-code:set-effort',
  claudeCodeSetUltracode: 'claude-code:set-ultracode',
  claudeCodeListModels: 'claude-code:list-models',
  claudeCodeDebugFlags: 'claude-code:debug-flags',

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
