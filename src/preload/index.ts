import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '../shared/ipc'
import type {
  AiChatRequest,
  AiConversationsState,
  AiProviderKind,
  AiStreamEvent,
  ClaudePermissionDecision,
  ClaudeStartOpts,
  ClaudeStreamEvent,
  HistoryEntry,
  PrepareQuitPayload,
  PtySpawnRequest,
  SessionSnapshot,
  Settings,
  WindowCommand,
  WorkflowDef,
  WorkspaceState
} from '../shared/types'

type Unsub = () => void

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): Unsub {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as T))
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  pty: {
    spawn: (req: PtySpawnRequest) => ipcRenderer.invoke(CH.ptySpawn, req),
    write: (sessionId: string, data: string) => ipcRenderer.send(CH.ptyWrite, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send(CH.ptyResize, sessionId, cols, rows),
    kill: (sessionId: string) => ipcRenderer.send(CH.ptyKill, sessionId),
    onData: (cb: (sessionId: string, data: string) => void) => on(CH.ptyData, cb),
    onExit: (cb: (sessionId: string, exitCode: number) => void) => on(CH.ptyExit, cb)
  },
  sessions: {
    list: () => ipcRenderer.invoke(CH.sessionsList),
    saveSnapshot: (snap: SessionSnapshot) => ipcRenderer.invoke(CH.sessionsSaveSnapshot, snap),
    loadSnapshot: (id: string) => ipcRenderer.invoke(CH.sessionsLoadSnapshot, id),
    delete: (id: string) => ipcRenderer.invoke(CH.sessionsDelete, id),
    setFlag: (id: string, flag: 'pinned' | 'favorite', value: boolean) =>
      ipcRenderer.invoke(CH.sessionsSetFlag, id, flag, value),
    rename: (id: string, title: string) => ipcRenderer.invoke(CH.sessionsRename, id, title),
    saveWorkspace: (ws: WorkspaceState) => ipcRenderer.invoke(CH.sessionsSaveWorkspace, ws),
    loadWorkspace: () => ipcRenderer.invoke(CH.sessionsLoadWorkspace),
    onPrepareQuit: (cb: (p: PrepareQuitPayload) => void) => on(CH.prepareQuit, cb),
    readyToQuit: () => ipcRenderer.send(CH.readyToQuit)
  },
  aiConversations: {
    save: (state: AiConversationsState) => ipcRenderer.invoke(CH.aiConversationsSave, state),
    load: () => ipcRenderer.invoke(CH.aiConversationsLoad)
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(CH.settingsSet, patch),
    onChange: (cb: (s: Settings) => void) => on(CH.settingsChanged, cb),
    setSecret: (provider: AiProviderKind, key: string) =>
      ipcRenderer.invoke(CH.settingsSetSecret, provider, key),
    providerStatus: () => ipcRenderer.invoke(CH.settingsProviderStatus)
  },
  shells: {
    detect: () => ipcRenderer.invoke(CH.shellsDetect)
  },
  aiClis: {
    detect: () => ipcRenderer.invoke(CH.aiClisDetect)
  },
  ai: {
    chat: (requestId: string, req: AiChatRequest) => ipcRenderer.send(CH.aiChat, requestId, req),
    abort: (requestId: string) => ipcRenderer.send(CH.aiAbort, requestId),
    onStream: (cb: (requestId: string, ev: AiStreamEvent) => void) => on(CH.aiStream, cb),
    listOllamaModels: (baseUrl: string) => ipcRenderer.invoke(CH.aiOllamaModels, baseUrl)
  },
  claudeCode: {
    start: (requestId: string, opts: ClaudeStartOpts) =>
      ipcRenderer.send(CH.claudeCodeStart, requestId, opts),
    input: (requestId: string, text: string) =>
      ipcRenderer.send(CH.claudeCodeInput, requestId, text),
    interrupt: (requestId: string) => ipcRenderer.send(CH.claudeCodeInterrupt, requestId),
    permission: (requestId: string, toolUseId: string, decision: ClaudePermissionDecision) =>
      ipcRenderer.send(CH.claudeCodePermission, requestId, toolUseId, decision),
    onStream: (cb: (requestId: string, ev: ClaudeStreamEvent) => void) =>
      on(CH.claudeCodeStream, cb),
    listSessions: (cwd: string | undefined) =>
      ipcRenderer.invoke(CH.claudeCodeListSessions, cwd),
    sessionMessages: (sessionId: string, cwd: string | undefined) =>
      ipcRenderer.invoke(CH.claudeCodeSessionMessages, sessionId, cwd),
    setModel: (requestId: string, model: string | undefined) =>
      ipcRenderer.send(CH.claudeCodeSetModel, requestId, model),
    setBypass: (requestId: string, bypass: boolean) =>
      ipcRenderer.send(CH.claudeCodeSetBypass, requestId, bypass),
    setEffort: (requestId: string, effort: string | undefined) =>
      ipcRenderer.send(CH.claudeCodeSetEffort, requestId, effort),
    setUltracode: (requestId: string, on: boolean) =>
      ipcRenderer.send(CH.claudeCodeSetUltracode, requestId, on),
    listModels: () => ipcRenderer.invoke(CH.claudeCodeListModels),
    debugFlags: (requestId?: string) => ipcRenderer.invoke(CH.claudeCodeDebugFlags, requestId)
  },
  fs: {
    readDir: (path: string) => ipcRenderer.invoke(CH.fsReadDir, path),
    readFile: (path: string) => ipcRenderer.invoke(CH.fsReadFile, path),
    writeFile: (path: string, content: string) =>
      ipcRenderer.invoke(CH.fsWriteFile, path, content),
    stat: (path: string) => ipcRenderer.invoke(CH.fsStat, path),
    create: (path: string, isDir: boolean) => ipcRenderer.invoke(CH.fsCreate, path, isDir),
    rename: (from: string, to: string) => ipcRenderer.invoke(CH.fsRename, from, to),
    delete: (path: string) => ipcRenderer.invoke(CH.fsDelete, path)
  },
  git: {
    status: (cwd: string) => ipcRenderer.invoke(CH.gitStatus, cwd),
    diffFile: (cwd: string, path: string) => ipcRenderer.invoke(CH.gitDiffFile, cwd, path)
  },
  history: {
    add: (entry: HistoryEntry) => ipcRenderer.invoke(CH.historyAdd, entry),
    search: (query: string, limit?: number) => ipcRenderer.invoke(CH.historySearch, query, limit)
  },
  workflows: {
    list: () => ipcRenderer.invoke(CH.workflowsList),
    save: (wf: WorkflowDef) => ipcRenderer.invoke(CH.workflowsSave, wf),
    delete: (id: string) => ipcRenderer.invoke(CH.workflowsDelete, id)
  },
  app: {
    info: () => ipcRenderer.invoke(CH.appInfo),
    windowCommand: (cmd: WindowCommand) => ipcRenderer.send(CH.windowCommand, cmd),
    onMaximized: (cb: (maximized: boolean) => void) => on(CH.windowMaximized, cb),
    openExternal: (url: string) => ipcRenderer.send(CH.openExternal, url),
    showItemInFolder: (path: string) => ipcRenderer.send(CH.showItemInFolder, path),
    pickDirectory: () => ipcRenderer.invoke(CH.pickDirectory),
    /** Resolve an absolute path for a dropped File (drag-and-drop a folder). */
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    setOpacity: (value: number) => ipcRenderer.send(CH.setOpacity, value)
  }
}

export type ZaryaApi = typeof api

contextBridge.exposeInMainWorld('zarya', api)
