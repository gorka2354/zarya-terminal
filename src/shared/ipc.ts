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
  aiModels: 'ai:models',

  // native agent drivers (claude-code, codex, gemini). Renderer->main calls carry
  // `engine` as the first arg so the main handler routes to the registry driver.
  agentCapabilities: 'agent:capabilities', // engine -> AgentCapabilities map (for UI gating)
  agentStart: 'agent:start',
  agentInput: 'agent:input',
  agentInterrupt: 'agent:interrupt',
  /** Отмена отправленного сообщения: убрать его и из контекста агента. */
  agentRewind: 'agent:rewind',
  agentPermission: 'agent:permission',
  agentQuestion: 'agent:question', // resolve a structured AskUserQuestion-style prompt
  agentStream: 'agent:stream', // main -> renderer, payload carries `engine`
  agentListSessions: 'agent:list-sessions',
  agentSessionMessages: 'agent:session-messages',
  agentSetModel: 'agent:set-model',
  agentSetBypass: 'agent:set-bypass',
  agentSetPermissionMode: 'agent:set-permission-mode',
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
  historyClear: 'history:clear',
  historyStats: 'history:stats',

  // workflows
  workflowsList: 'workflows:list',
  workflowsSave: 'workflows:save',
  workflowsDelete: 'workflows:delete',

  // speech-to-text (local dictation)
  sttState: 'stt:state',
  sttEnsureModel: 'stt:ensure-model',
  sttProgress: 'stt:progress', // main -> renderer
  sttTranscribe: 'stt:transcribe',
  sttRemoveModel: 'stt:remove-model',
  /** Агент встал и ждёт человека, а окно не в фокусе — позвать. */
  notifyWaiting: 'app:notify-waiting',
  /** Команды движка для палитры «/». */
  agentListCommands: 'agent:list-commands',
  /** Перечитать скиллы/плагины/MCP на живой сессии, не перезапуская её. */
  agentReloadExtras: 'agent:reload-extras',
  /** На диске появились новые скиллы/плагины/MCP (main -> renderer). */
  agentExtrasChanged: 'agent:extras-changed',
  /** Движок сообщил, что список команд изменился (main -> renderer). */
  agentCommandsChanged: 'agent:commands-changed',
  /** Состав и здоровье MCP-серверов ОДНОЙ беседы. */
  agentMcpStatus: 'agent:mcp-status',
  /** Переподключить сервер живой беседы. */
  agentMcpReconnect: 'agent:mcp-reconnect',
  agentStopTask: 'agent:stop-task',
  /** Увести идущую работу в фон: одну задачу или всё сразу (Ctrl+B движка). */
  agentBackgroundTasks: 'agent:background-tasks',
  agentApplyDirs: 'agent:apply-dirs',
  agentHealth: 'agent:health',
  /** main -> renderer: открыть папку, названную в командной строке. */
  openFolderArg: 'app:open-folder-arg',
  /** renderer -> main: забрать папку, накопленную первым запуском. */
  takeFolderArg: 'app:take-folder-arg',
  /** Включить/выключить сервер живой беседы (пишет в конфиг движка). */
  agentMcpToggle: 'agent:mcp-toggle',
  /** Состояние скилла в настройках движка: в работе / только имя / «/» / выкл. */
  agentSkillOverride: 'agent:skill-override',
  /** Скилл сработал — счётчик на ЭТОЙ машине, наружу ничего не уходит. */
  agentSkillUsed: 'agent:skill-used',
  /** Сводка срабатываний: сколько раз что сработало и сколько дней смотрим. */
  agentSkillUsage: 'agent:skill-usage',
  /** Забыть наблюдение и начать заново. */
  agentSkillUsageClear: 'agent:skill-usage-clear',
  /** Своя модель с диска: main спрашивает папку сам, renderer путей не подаёт. */
  sttAddCustom: 'stt:add-custom',
  sttForgetCustom: 'stt:forget-custom',

  // проверка обновлений
  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesChanged: 'updates:changed', // main -> renderer
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',

  // app / window
  appInfo: 'app:info',
  windowCommand: 'window:command',
  windowMaximized: 'window:maximized', // main -> renderer
  openExternal: 'app:open-external',
  showItemInFolder: 'app:show-item-in-folder',
  /** Сколько места занимают копии файлов движка (для честной строки в настройках). */
  checkpointUsage: 'checkpoints:usage',
  /** Наши страховочные копии: размер и очистка по просьбе человека. */
  backupUsage: 'rewind:backup-usage',
  backupClear: 'rewind:backup-clear',
  /** Вернуть файлы к состоянию на ходе (или посмотреть, что будет). */
  agentRewindFiles: 'agent:rewind-files',
  /** Команда `zarya` в системе: состояние, установка и снятие. */
  cliStatus: 'cli:status',
  cliInstall: 'cli:install',
  cliRemove: 'cli:remove',
  pickDirectory: 'app:pick-directory',
  saveTextFile: 'app:save-text-file',
  setOpacity: 'app:set-opacity'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
