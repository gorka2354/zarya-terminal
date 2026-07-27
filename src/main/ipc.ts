import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { APP_VERSION } from './appVersion'
import { existsSync } from 'fs'
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
import type { SttService } from './sttService'
import type { UpdateService } from './updateService'
import { detectAiClis } from './aiClis'
import { detectShells, resolveProfile } from './shellProfiles'
import {
  describeProfile,
  newlyExecutable,
  sanitizeProfile,
  sanitizeProfiles
} from './shellProfileGuard'
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
  /** Local speech-to-text (dictation into the bar). */
  stt: SttService
  updates: UpdateService
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

  /**
   * SECURITY: `terminal.customProfiles` names programs the app will spawn, and
   * this channel is reachable from the renderer — so a compromised renderer could
   * otherwise register a profile and have its binary launched on every later
   * start. That converts a transient compromise into persistence.
   *
   * Two rules. Structurally invalid entries are dropped (see shellProfileGuard).
   * Anything that would newly EXECUTE something — a new profile, or an edit to a
   * path/argv/env/integration — additionally requires the user to confirm, with
   * the path and argv shown verbatim. Declining leaves the stored profiles
   * untouched; it never half-applies. Renames and icon changes don't prompt.
   */
  /** How many profiles the confirmation dialog spells out before summarising. */
  const SHOWN_PROFILES = 5

  async function guardProfilePatch(patch: Partial<Settings>): Promise<Partial<Settings>> {
    const terminalPatch = patch.terminal as Partial<Settings['terminal']> | undefined
    if (terminalPatch?.customProfiles === undefined) return patch

    const prev = settingsStore.get().terminal.customProfiles
    const next = sanitizeProfiles(terminalPatch.customProfiles, existsSync)
    const withProfiles = (profiles: typeof prev): Partial<Settings> => ({
      ...patch,
      terminal: { ...terminalPatch, customProfiles: profiles } as Settings['terminal']
    })

    const fresh = newlyExecutable(prev, next)
    if (fresh.length === 0) return withProfiles(next)

    const win = getWindow()
    const opts = {
      type: 'warning' as const,
      buttons: ['Отклонить', 'Добавить профиль'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Заря — новый профиль терминала',
      message:
        fresh.length === 1
          ? 'Приложение просит добавить профиль терминала'
          : `Приложение просит добавить профили терминала (${fresh.length})`,
      // Native dialogs don't scroll: show a handful and say how many more there
      // are, rather than emitting a wall of text whose tail is unreachable.
      detail:
        `Профиль запускает указанную программу при каждом открытии терминала — и остаётся после перезапуска.\n\n` +
        fresh.slice(0, SHOWN_PROFILES).map(describeProfile).join('\n\n') +
        (fresh.length > SHOWN_PROFILES
          ? `\n\n…и ещё ${fresh.length - SHOWN_PROFILES} — будут добавлены все.`
          : '') +
        `\n\nЕсли вы этого не делали, отклоните.`
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    // Fail closed: anything other than an explicit "add" keeps the old list.
    // Re-read it after the await — the snapshot taken before the dialog opened
    // may be stale if another settings:set landed meanwhile, and writing it back
    // would silently undo that one (mergeDeep replaces arrays wholesale).
    return withProfiles(response === 1 ? next : settingsStore.get().terminal.customProfiles)
  }

  // ------------------------------------------------------------------- pty
  ipcMain.handle(CH.ptySpawn, async (_e, req: PtySpawnRequest) => {
    const settings = settingsStore.get()
    const profile = await resolveProfile(
      req.profileId === 'auto' ? settings.terminal.defaultProfileId : req.profileId,
      settings.terminal.customProfiles
    )
    if (!profile) return { ok: false, error: 'Не найден ни один shell.' }
    // Defence in depth: the settings file is also editable by hand (and by
    // anything running as the user), so validate again at the point of spawn
    // rather than trusting that everything stored went through the gate above.
    // Detected profiles are re-checked too — they are cheap to validate and a
    // bad one would be just as executable.
    const safe = sanitizeProfile({ ...profile, detected: false }, existsSync)
    if (!safe) return { ok: false, error: 'Профиль терминала отклонён проверкой безопасности.' }
    return ptyManager.spawn(req, { ...safe, detected: profile.detected })
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
  ipcMain.handle(CH.settingsSet, async (_e, patch: Partial<Settings>) =>
    settingsStore.set(await guardProfilePatch(patch))
  )
  ipcMain.handle(CH.settingsSetSecret, (_e, provider: AiProviderKind, key: string) =>
    settingsStore.setSecret(provider, key)
  )
  ipcMain.handle(CH.settingsProviderStatus, () => settingsStore.providerStatus())

  // ------------------------------------------------------------------- stt
  // Проверка обновлений. Наружу отдаётся только разобранный результат: адреса
  // рендерер не строит и из ответа сервера не получает (см. @shared/updates).
  ipcMain.handle(CH.updatesState, () => ctx.updates.get())
  ipcMain.handle(CH.updatesCheck, () => ctx.updates.check())
  ctx.updates.onChange((s) => getWindow()?.webContents.send(CH.updatesChanged, s))

  ipcMain.handle(CH.sttState, () => ctx.stt.state())
  ipcMain.handle(CH.sttEnsureModel, async () => {
    try {
      await ctx.stt.ensureModel((p) => getWindow()?.webContents.send(CH.sttProgress, p))
      getWindow()?.webContents.send(CH.sttProgress, null)
      return { ok: true }
    } catch (e) {
      getWindow()?.webContents.send(CH.sttProgress, null)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(CH.sttTranscribe, async (_e, samples: unknown, sampleRate: unknown) => {
    // Bound what the renderer can hand us: a 5-minute utterance at 48 kHz is
    // already far past dictation, and an unbounded buffer is an easy way to
    // exhaust memory in the main process.
    const MAX_SAMPLES = 48000 * 300
    const rate = typeof sampleRate === 'number' && sampleRate >= 8000 && sampleRate <= 192000 ? sampleRate : 0
    if (!rate) return { ok: false, error: 'Некорректная частота дискретизации' }
    if (!(samples instanceof Float32Array) || samples.length === 0)
      return { ok: false, error: 'Пустая запись' }
    if (samples.length > MAX_SAMPLES) return { ok: false, error: 'Запись слишком длинная' }
    try {
      const text = await ctx.stt.transcribe(samples, rate)
      return { ok: true, text }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

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
    version: APP_VERSION,
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
