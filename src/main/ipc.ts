import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { CH } from '@shared/ipc'
import type {
  AgentEngine,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentStartOpts,
  AiChatRequest,
  AiConversationsState,
  AiProviderKind,
  HistoryEntry,
  PtySpawnRequest,
  SessionSnapshot,
  Settings,
  WindowCommand,
  WorkflowDef,
  WorkspaceState
} from '@shared/types'
import type { AiProxy } from './aiProxy'
import type { AgentDriver } from './agentDriver'
import * as fsService from './fsService'
import * as gitService from './gitService'
import type { HistoryStore } from './historyStore'
import type { PtyManager } from './ptyManager'
import type { SessionStore } from './sessionStore'
import type { SettingsStore } from './settingsStore'
import { detectAiClis } from './aiClis'
import { detectShells, resolveProfile } from './shellProfiles'
import type { WorkflowStore } from './workflowStore'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  ptyManager: PtyManager
  settingsStore: SettingsStore
  sessionStore: SessionStore
  historyStore: HistoryStore
  workflowStore: WorkflowStore
  aiProxy: AiProxy
  /** Registry of native agent drivers, keyed by engine. */
  agentRegistry: Map<AgentEngine, AgentDriver>
  requestQuitConfirmed: () => void
}

export function registerIpc(ctx: IpcContext): void {
  const {
    getWindow,
    ptyManager,
    settingsStore,
    sessionStore,
    historyStore,
    workflowStore,
    aiProxy,
    agentRegistry
  } = ctx
  const driverFor = (engine: AgentEngine): AgentDriver | undefined => agentRegistry.get(engine)

  // ------------------------------------------------------------------- pty
  ipcMain.handle(CH.ptySpawn, async (_e, req: PtySpawnRequest) => {
    const settings = settingsStore.get()
    const profile = await resolveProfile(
      req.profileId === 'auto' ? settings.terminal.defaultProfileId : req.profileId,
      settings.terminal.customProfiles
    )
    if (!profile) return { ok: false, error: 'Не найден ни один shell.' }
    return ptyManager.spawn(req, profile)
  })
  ipcMain.on(CH.ptyWrite, (_e, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data)
  })
  ipcMain.on(CH.ptyResize, (_e, sessionId: string, cols: number, rows: number) => {
    ptyManager.resize(sessionId, cols, rows)
  })
  ipcMain.on(CH.ptyKill, (_e, sessionId: string) => {
    ptyManager.kill(sessionId)
  })

  // -------------------------------------------------------------- sessions
  ipcMain.handle(CH.sessionsList, () => sessionStore.list())
  ipcMain.handle(CH.sessionsSaveSnapshot, (_e, snap: SessionSnapshot) =>
    sessionStore.saveSnapshot(snap)
  )
  ipcMain.handle(CH.sessionsLoadSnapshot, (_e, id: string) => sessionStore.loadSnapshot(id))
  ipcMain.handle(CH.sessionsDelete, (_e, id: string) => sessionStore.delete(id))
  ipcMain.handle(CH.sessionsSetFlag, (_e, id: string, flag: 'pinned' | 'favorite', v: boolean) =>
    sessionStore.setFlag(id, flag, v)
  )
  ipcMain.handle(CH.sessionsRename, (_e, id: string, title: string) =>
    sessionStore.rename(id, title)
  )
  ipcMain.handle(CH.sessionsSaveWorkspace, (_e, ws: WorkspaceState) =>
    sessionStore.saveWorkspace(ws)
  )
  ipcMain.handle(CH.sessionsLoadWorkspace, () => sessionStore.loadWorkspace())
  ipcMain.handle(CH.aiConversationsSave, (_e, state: AiConversationsState) =>
    sessionStore.saveConversations(state)
  )
  ipcMain.handle(CH.aiConversationsLoad, () => sessionStore.loadConversations())
  ipcMain.on(CH.readyToQuit, () => ctx.requestQuitConfirmed())

  // -------------------------------------------------------------- settings
  ipcMain.handle(CH.settingsGet, () => settingsStore.get())
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => settingsStore.set(patch))
  ipcMain.handle(CH.settingsSetSecret, (_e, provider: AiProviderKind, key: string) =>
    settingsStore.setSecret(provider, key)
  )
  ipcMain.handle(CH.settingsProviderStatus, () => settingsStore.providerStatus())

  // ---------------------------------------------------------------- shells
  ipcMain.handle(CH.shellsDetect, async () => {
    const settings = settingsStore.get()
    return [...settings.terminal.customProfiles, ...(await detectShells())]
  })

  // --------------------------------------------------------------- ai clis
  ipcMain.handle(CH.aiClisDetect, () => detectAiClis())

  // -------------------------------------------------------------------- ai
  ipcMain.on(CH.aiChat, (_e, requestId: string, req: AiChatRequest) => {
    const key = settingsStore.getSecret(req.provider)
    // SECURITY: never forward a renderer-supplied baseUrl to a provider that
    // has a stored API key. The renderer is untrusted for this purpose — an
    // arbitrary baseUrl would make main attach the decrypted key (x-api-key /
    // Authorization) to whatever host the renderer names, leaking it. Only
    // the baseUrl the user actually configured in Settings is trusted; use it
    // when it matches the request's provider, otherwise fall back to the
    // provider's default official host (empty string, aiProxy fills it in).
    if (key) {
      const settings = settingsStore.get()
      req = {
        ...req,
        baseUrl: req.provider === settings.ai.provider ? settings.ai.baseUrl : ''
      }
    }
    void aiProxy.chat(requestId, req, key)
  })
  ipcMain.on(CH.aiAbort, (_e, requestId: string) => aiProxy.abort(requestId))
  ipcMain.handle(CH.aiOllamaModels, (_e, baseUrl: string) => aiProxy.listOllamaModels(baseUrl))

  // ------------------------------------------------- native agent drivers (registry)
  // Every renderer->main call carries `engine` first; we look the driver up in the
  // registry and route. Optional methods are guarded (`?.`) so a driver lacking a
  // capability is a safe no-op rather than a crash.
  // A driver may declare a `probe()` (is its backend installed?). We cache the
  // result per engine and only advertise engines that probe OK, so an engine
  // whose CLI isn't installed (e.g. Codex on a machine without it) never shows a
  // dead chip — the renderer gates UI on the engines present in this map.
  const probeCache = new Map<AgentEngine, Promise<boolean>>()
  const isAvailable = (engine: AgentEngine, d: AgentDriver): Promise<boolean> => {
    if (!d.probe) return Promise.resolve(true)
    let p = probeCache.get(engine)
    if (!p) {
      p = d.probe().catch(() => false)
      probeCache.set(engine, p)
    }
    return p
  }
  ipcMain.handle(CH.agentCapabilities, async () => {
    const entries = await Promise.all(
      [...agentRegistry].map(
        async ([engine, d]) =>
          [engine, (await isAvailable(engine, d)) ? d.capabilities : null] as const
      )
    )
    return Object.fromEntries(entries.filter(([, c]) => c != null))
  })
  ipcMain.on(CH.agentStart, (_e, engine: AgentEngine, requestId: string, opts: AgentStartOpts) => {
    void driverFor(engine)?.start(requestId, opts)
  })
  ipcMain.on(CH.agentInput, (_e, engine: AgentEngine, requestId: string, text: string) => {
    driverFor(engine)?.input(requestId, text)
  })
  ipcMain.on(CH.agentInterrupt, (_e, engine: AgentEngine, requestId: string) => {
    driverFor(engine)?.interrupt(requestId)
  })
  ipcMain.on(
    CH.agentPermission,
    (_e, engine: AgentEngine, requestId: string, toolUseId: string, decision: AgentPermissionDecision) => {
      driverFor(engine)?.resolvePermission(requestId, toolUseId, decision)
    }
  )
  ipcMain.on(
    CH.agentQuestion,
    (_e, engine: AgentEngine, requestId: string, toolUseId: string, answer: AgentQuestionAnswer) => {
      driverFor(engine)?.resolveQuestion?.(requestId, toolUseId, answer)
    }
  )
  ipcMain.handle(CH.agentListSessions, (_e, engine: AgentEngine, cwd: string | undefined) =>
    driverFor(engine)?.listSessions?.(cwd) ?? []
  )
  ipcMain.handle(
    CH.agentSessionMessages,
    (_e, engine: AgentEngine, sessionId: string, cwd: string | undefined) =>
      driverFor(engine)?.loadSessionMessages?.(sessionId, cwd) ?? []
  )
  ipcMain.on(CH.agentSetModel, (_e, engine: AgentEngine, requestId: string, model: string | undefined) =>
    driverFor(engine)?.setModel?.(requestId, model)
  )
  ipcMain.on(CH.agentSetBypass, (_e, engine: AgentEngine, requestId: string, bypass: boolean) =>
    driverFor(engine)?.setBypass?.(requestId, bypass)
  )
  ipcMain.on(CH.agentSetEffort, (_e, engine: AgentEngine, requestId: string, effort: string | undefined) =>
    driverFor(engine)?.setEffort?.(requestId, effort)
  )
  ipcMain.on(
    CH.agentSetVendorFlag,
    (_e, engine: AgentEngine, requestId: string, key: string, value: unknown) =>
      driverFor(engine)?.setVendorFlag?.(requestId, key, value)
  )
  ipcMain.handle(CH.agentListModels, (_e, engine: AgentEngine) => driverFor(engine)?.listModels?.() ?? [])
  ipcMain.handle(CH.agentDebugFlags, (_e, engine: AgentEngine, requestId?: string) =>
    driverFor(engine)?.debugFlags?.(requestId) ?? {}
  )

  // --------------------------------------------------------------- fs / git
  ipcMain.handle(CH.fsReadDir, (_e, path: string) => fsService.readDir(path))
  ipcMain.handle(CH.fsReadFile, (_e, path: string) => fsService.readFile(path))
  ipcMain.handle(CH.fsWriteFile, (_e, path: string, content: string) =>
    fsService.writeFile(path, content)
  )
  ipcMain.handle(CH.fsStat, (_e, path: string) => fsService.statPath(path))
  ipcMain.handle(CH.fsCreate, (_e, path: string, isDir: boolean) =>
    fsService.createEntry(path, isDir)
  )
  ipcMain.handle(CH.fsRename, (_e, from: string, to: string) => fsService.renameEntry(from, to))
  ipcMain.handle(CH.fsDelete, (_e, path: string) => fsService.deleteEntry(path))
  ipcMain.handle(CH.gitStatus, (_e, cwd: string) => gitService.gitStatus(cwd))
  ipcMain.handle(CH.gitDiffFile, (_e, cwd: string, path: string) =>
    gitService.gitDiffFile(cwd, path)
  )

  // --------------------------------------------------------------- history
  ipcMain.handle(CH.historyAdd, (_e, entry: HistoryEntry) => historyStore.add(entry))
  ipcMain.handle(CH.historySearch, (_e, query: string, limit?: number) =>
    historyStore.search(query, limit)
  )

  // ------------------------------------------------------------- workflows
  ipcMain.handle(CH.workflowsList, () => workflowStore.list())
  ipcMain.handle(CH.workflowsSave, (_e, wf: WorkflowDef) => workflowStore.save(wf))
  ipcMain.handle(CH.workflowsDelete, (_e, id: string) => workflowStore.delete(id))

  // ------------------------------------------------------------ app/window
  ipcMain.handle(CH.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userDataPath: app.getPath('userData')
  }))
  ipcMain.on(CH.windowCommand, (_e, cmd: WindowCommand) => {
    const win = getWindow()
    if (!win) return
    switch (cmd) {
      case 'minimize':
        win.minimize()
        break
      case 'maximize':
        win.isMaximized() ? win.unmaximize() : win.maximize()
        break
      case 'close':
        win.close()
        break
      case 'devtools':
        win.webContents.toggleDevTools()
        break
    }
  })
  ipcMain.on(CH.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  ipcMain.on(CH.showItemInFolder, (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle(CH.pickDirectory, async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.on(CH.setOpacity, (_e, value: number) => {
    const win = getWindow()
    if (!win) return
    const v = Math.min(1, Math.max(0.3, value))
    win.setOpacity(v)
  })
}
