import { BrowserWindow, Notification, app, dialog, ipcMain, shell } from 'electron'
import { tm } from './lang'
import { APP_VERSION } from './appVersion'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { CH } from '@shared/ipc'
import type {
  AgentEngine,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentRewind,
  AgentStartOpts,
  AiChatRequest,
  AiConversationsState,
  AiProviderKind,
  HistoryEntry,
  PtySpawnRequest,
  RewindFilesOutcome,
  SessionSnapshot,
  Settings,
  WindowCommand,
  WorkflowDef,
  WorkspaceState
} from '@shared/types'
import type { AiProxy } from './aiProxy'
import { ModelCatalogStore } from './modelCatalogStore'
import { SkillUsageStore } from './skillUsageStore'
import { ExtrasWatcher } from './extrasWatcher'
import { withCustom } from '@shared/sttCustom'
import { cliInstall, cliRemove, cliStatus } from './cliCommand'
import type { AgentDriver } from './agentDriver'
import * as fsService from './fsService'
import * as gitService from './gitService'
import type { HistoryStore } from './historyStore'
import type { PtyManager } from './ptyManager'
import type { SessionStore } from './sessionStore'
import { checkpointPolicy } from '@shared/checkpointPolicy'
import { checkpointUsage, fileHistoryDir } from './checkpointStore'
import { diskFacts, verifyRewind } from './rewindFacts'
import { agentFiles, agentFileStore, compareNote } from './agentFileMap'
import { backupBeforeRewind, backupUsage, clearBackups } from './rewindBackup'
import { staleAgainst, type SeenFile } from '@shared/rewindPlan'
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
  /**
   * Папки, названные в командной строке. Очередь, а не одна: пока окно
   * поднимается, второй запуск может прийти не однажды.
   */
  takeFolderArgs: () => { dir?: string; bad?: string }[]
  requestQuitConfirmed: () => void
}

/** Следит за скиллами и MCP на диске: один на процесс. */
const extrasWatcher = new ExtrasWatcher()

/** Последний известный каталог моделей: свой на процесс, файл в userData. */
const modelCatalogStore = new ModelCatalogStore()

/** Счётчик срабатываний скиллов: файл в данных Зари, наружу ничего не уходит. */
const skillUsageStore = new SkillUsageStore()

/** Дописать счётчик при выходе: иначе последняя минута работы теряется. */
export function flushSkillUsage(): Promise<void> {
  return skillUsageStore.flush()
}

/**
 * Сколько ждёт ГРАНИЦА, за которой стоит человек.
 *
 * Заведомо больше драйверного предела: пусть сначала ответит сам драйвер — он
 * знает причину точнее и снимает за собой аренду сессии. Эта цифра ловит те
 * драйверы, у которых своего предела нет вовсе.
 */
const REWIND_IPC_TIMEOUT_MS = Number(process.env.ZARYA_QA_REWIND_TIMEOUT_MS) || 150_000

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
      buttons: [tm('main.dlg.decline'), tm('main.dlg.addProfile')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: tm('main.dlg.title'),
      message:
        fresh.length === 1 ? tm('main.dlg.msgOne') : tm('main.dlg.msgMany', { n: fresh.length }),
      // Native dialogs don't scroll: show a handful and say how many more there
      // are, rather than emitting a wall of text whose tail is unreachable.
      detail:
        `${tm('main.dlg.detailHead')}\n\n` +
        fresh.slice(0, SHOWN_PROFILES).map(describeProfile).join('\n\n') +
        (fresh.length > SHOWN_PROFILES
          ? `\n\n${tm('main.dlg.detailMore', { n: fresh.length - SHOWN_PROFILES })}`
          : '') +
        `\n\n${tm('main.dlg.detailTail')}`
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
    if (!profile) return { ok: false, error: tm('main.err.noShell') }
    // Defence in depth: the settings file is also editable by hand (and by
    // anything running as the user), so validate again at the point of spawn
    // rather than trusting that everything stored went through the gate above.
    // Detected profiles are re-checked too — they are cheap to validate and a
    // bad one would be just as executable.
    const safe = sanitizeProfile({ ...profile, detected: false }, existsSync)
    if (!safe) return { ok: false, error: tm('main.err.profileUnsafe') }
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
  ipcMain.handle(CH.updatesDownload, () => ctx.updates.download())
  ipcMain.handle(CH.updatesInstall, () => ctx.updates.install())
  ctx.updates.onChange((s) => getWindow()?.webContents.send(CH.updatesChanged, s))

  /**
   * Позвать человека к панели, которая встала.
   *
   * Два разных зова, и оба нужны. Уведомление ОС видно, когда Заря свёрнута;
   * подсветка кнопки в панели задач — когда окно просто под другим окном. Ни
   * то ни другое не показывается, если окно в фокусе: там человек и так
   * смотрит.
   *
   * Клик по уведомлению поднимает окно — иначе оно сообщает о деле, к которому
   * нельзя перейти.
   */
  /*
   * Зов человека к окну. `kind` обязателен по существу: тумблеров теперь два —
   * «агент ждёт решения» и «долгая команда закончилась», — и один гейт на оба
   * означал бы, что выключение первого молча гасит второй. Настройка, которая
   * выключает не только то, что названо, — худший вид настройки.
   */
  ipcMain.on(CH.notifyWaiting, (_e, title: string, body: string, kind?: string) => {
    const win = getWindow()
    if (!win || win.isFocused()) return
    const rules = settingsStore.get().notifications
    const allowed = kind === 'done' ? rules?.whenLongDone : rules?.whenWaiting
    if (!allowed) return
    // На Windows это мигание кнопки в панели задач, на macOS — подпрыгивание
    // иконки в доке. Снимается само, когда окно получает фокус.
    win.flashFrame(true)
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  })

  ipcMain.handle(CH.sttState, () => ctx.stt.state())
  /**
   * Добавить свою модель распознавания.
   *
   * Канал принимает КОМАНДУ «спроси человека», а не готовый путь: renderer не
   * может подсунуть сюда каталог, диалог открывает главный процесс. Это тот же
   * жест, что «Открыть файл» в редакторе — и ровно поэтому здесь не появится
   * поля со ссылкой: скачать чужой файл в нативный движок и открыть свой —
   * разные вещи.
   *
   * ZARYA_STT_PICK_DIR — рубильник для прогонов: системный диалог не нажимается
   * из Playwright, а проверять надо всё, что после него.
   */
  ipcMain.handle(CH.sttAddCustom, async () => {
    const win = getWindow()
    const forced = process.env.ZARYA_STT_PICK_DIR
    let dir: string | null = forced ?? null
    if (!dir) {
      if (!win) return { ok: false, error: tm('main.stt.custom.dirUnreadable') }
      const res = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: tm('main.stt.custom.pickTitle')
      })
      if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
      dir = res.filePaths[0]
    }
    // Проверка запускает модель в отдельном процессе и на крупных занимает
    // секунды — оттого и await: ответ приходит, когда ответ уже настоящий.
    const found = await ctx.stt.identifyDir(dir)
    if (!found.ok) return found
    const voice = settingsStore.get().voice
    const list = withCustom(voice.customModels ?? [], found.model)
    // Новая модель сразу становится выбранной: человек добавил её не для того,
    // чтобы потом искать её в списке и нажимать «Выбрать».
    settingsStore.set({ voice: { ...voice, customModels: list, modelId: found.model.id } })
    return { ok: true, model: found.model }
  })
  ipcMain.handle(CH.sttForgetCustom, (_e, id: string) => {
    const voice = settingsStore.get().voice
    const list = (voice.customModels ?? []).filter((m) => m.id !== id)
    // Файлы остаются на диске: их принесла не Заря, и удалять чужое она не
    // будет. Выбор сбрасывается на умолчание, только если убрали выбранное.
    settingsStore.set({
      voice: { ...voice, customModels: list, modelId: voice.modelId === id ? '' : voice.modelId }
    })
    return { ok: true }
  })
  ipcMain.handle(CH.sttRemoveModel, (_e, id: string) => ctx.stt.removeModel(id))
  ipcMain.handle(CH.sttEnsureModel, async (_e, id?: string) => {
    try {
      await ctx.stt.ensureModel((p) => getWindow()?.webContents.send(CH.sttProgress, p), id)
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
    const rate =
      typeof sampleRate === 'number' && sampleRate >= 8000 && sampleRate <= 192000 ? sampleRate : 0
    if (!rate) return { ok: false, error: tm('main.err.badRate') }
    if (!(samples instanceof Float32Array) || samples.length === 0)
      return { ok: false, error: tm('main.err.emptyRec') }
    if (samples.length > MAX_SAMPLES) return { ok: false, error: tm('main.err.longRec') }
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

  /**
   * Каталог моделей провайдера — живой, с кешем.
   *
   * SECURITY: та же защита, что на ai:chat — адрес берётся из НАСТРОЕК, а не из
   * окна. Иначе renderer назвал бы чужой хост провайдеру с сохранённым ключом,
   * и главный процесс отправил бы туда ключ.
   */
  ipcMain.handle(CH.aiModels, async (_e, provider: AiProviderKind) => {
    const settings = settingsStore.get()
    const baseUrl = provider === settings.ai.provider ? settings.ai.baseUrl : ''
    const cached = await modelCatalogStore.get(provider)
    try {
      const ids = await aiProxy.listProviderModels(
        provider,
        baseUrl,
        settingsStore.getSecret(provider)
      )
      // Пустой ответ — не то же самое, что «нечего показать». Он бывает и
      // когда провайдер честно говорит «моделей нет» (человек сделал `ollama
      // rm`). Отдавать в этом случае вчерашний кеш молча значит показывать
      // удалённые модели как живые, поэтому кеш идёт с пометкой, а решает
      // окно: список видно, но он назван старым.
      if (!ids.length) return { ...cached, stale: true }
      return await modelCatalogStore.put(provider, ids)
    } catch (e) {
      // Молчать нельзя: список из кеша выглядит как свежий, и человек будет
      // думать, что новых моделей нет, хотя мы просто не смогли спросить.
      return { ...cached, error: e instanceof Error ? e.message : String(e) }
    }
  })

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
    // Чекпоинты файлов — решение приложения, а не окна: это запись копий на
    // диск (и в ЧУЖУЮ папку движка), поэтому значение берётся из настроек
    // здесь, а не приходит из рендерера вместе с остальными параметрами хода.
    // Плюс граница QA: копии лежат вне userData, и подмена профиля их НЕ
    // накрывает — прогон не должен писать в настоящий профиль человека.
    void driverFor(engine)?.start(requestId, {
      ...opts,
      fileCheckpoints: checkpointPolicy({
        wanted: settingsStore.get().ai.fileCheckpoints === true,
        isolated: !!process.env.ZARYA_USER_DATA,
        configDirOverridden: !!process.env.CLAUDE_CONFIG_DIR,
        // Живой прогон против настоящего движка: авторизация живёт в его
        // профиле, увести её нельзя — исключение просим явно.
        liveOverride: process.env.ZARYA_QA_LIVE_CHECKPOINTS === '1'
      }).on
    })
  })
  ipcMain.on(CH.agentInput, (_e, engine: AgentEngine, requestId: string, text: string) => {
    driverFor(engine)?.input(requestId, text)
  })
  ipcMain.on(CH.agentInterrupt, (_e, engine: AgentEngine, requestId: string) => {
    driverFor(engine)?.interrupt(requestId)
  })
  /**
   * Отмена ОТПРАВЛЕННОГО сообщения. Возвращает точку продолжения либо null:
   * только Claude Code умеет отматывать ветку, и рендерер обязан знать правду —
   * иначе он убрал бы сообщение из ленты там, где агент его всё равно помнит.
   */
  ipcMain.handle(CH.agentRewind, (_e, engine: AgentEngine, requestId: string) => {
    const d = driverFor(engine) as
      { rewindAfterInterrupt?: (id: string) => AgentRewind | null } | undefined
    return d?.rewindAfterInterrupt?.(requestId) ?? null
  })
  ipcMain.on(
    CH.agentPermission,
    (
      _e,
      engine: AgentEngine,
      requestId: string,
      toolUseId: string,
      decision: AgentPermissionDecision
    ) => {
      driverFor(engine)?.resolvePermission(requestId, toolUseId, decision)
    }
  )
  ipcMain.on(
    CH.agentQuestion,
    (
      _e,
      engine: AgentEngine,
      requestId: string,
      toolUseId: string,
      answer: AgentQuestionAnswer
    ) => {
      driverFor(engine)?.resolveQuestion?.(requestId, toolUseId, answer)
    }
  )
  ipcMain.handle(
    CH.agentListSessions,
    (_e, engine: AgentEngine, cwd: string | undefined) =>
      driverFor(engine)?.listSessions?.(cwd) ?? []
  )
  ipcMain.handle(
    CH.agentSessionMessages,
    (_e, engine: AgentEngine, sessionId: string, cwd: string | undefined) =>
      driverFor(engine)?.loadSessionMessages?.(sessionId, cwd) ?? []
  )
  ipcMain.on(
    CH.agentSetModel,
    (_e, engine: AgentEngine, requestId: string, model: string | undefined) =>
      driverFor(engine)?.setModel?.(requestId, model)
  )
  ipcMain.on(CH.agentSetBypass, (_e, engine: AgentEngine, requestId: string, bypass: boolean) =>
    driverFor(engine)?.setBypass?.(requestId, bypass)
  )
  ipcMain.on(
    CH.agentSetPermissionMode,
    (_e, engine: AgentEngine, requestId: string, mode: string) => {
      // Белый список на границе доверия: сюда допущены только режимы, КОТОРЫЕ
      // НЕ ОСЛАБЛЯЮТ гейт. 'bypassPermissions' и 'acceptEdits' сняли бы вопросы
      // ниже canUseTool — вне окна одобрений, о котором человек знает.
      if (mode !== 'plan' && mode !== 'default') return
      driverFor(engine)?.setPermissionMode?.(requestId, mode)
    }
  )
  ipcMain.on(
    CH.agentSetEffort,
    (_e, engine: AgentEngine, requestId: string, effort: string | undefined) =>
      driverFor(engine)?.setEffort?.(requestId, effort)
  )
  ipcMain.on(
    CH.agentSetVendorFlag,
    (_e, engine: AgentEngine, requestId: string, key: string, value: unknown) =>
      driverFor(engine)?.setVendorFlag?.(requestId, key, value)
  )
  ipcMain.handle(
    CH.agentListModels,
    (_e, engine: AgentEngine) => driverFor(engine)?.listModels?.() ?? []
  )
  /**
   * Команды движка для палитры «/».
   *
   * Ответ говорит не только СПИСОК, но и ОТКУДА он: движок, который команд не
   * называет, и движок, у которого их нет, — разные вещи. Пустой список без
   * этой пометки человек прочитает как «команд нет», и это будет неправдой.
   */
  /*
   * Наблюдатель за скиллами, командами, плагинами и .mcp.json.
   *
   * Заводится вместе с первым запросом на список команд — то есть когда панель
   * впервые заговорила с агентом. Раньше следить не за чем, а после — уже
   * поздно: человек как раз в этот момент ставит MCP-сервер и получает от
   * агента «перезапустите сессию».
   */
  ipcMain.handle(CH.agentReloadExtras, async (_e, engine: AgentEngine, requestId?: string) => {
    const driver = driverFor(engine)
    if (!driver?.reloadExtras) return { ok: false, unsupported: true }
    // Перечитываем ТУ беседу, из которой нажали: человек ставит сервер в
    // одном проекте и ждёт, что подхватит его панель, а не соседняя.
    return driver.reloadExtras(requestId)
  })
  /**
   * Состав инструментов ОДНОЙ беседы.
   *
   * requestId обязателен по смыслу задачи: `.mcp.json` проектный, окно
   * контекста — сессии. Ответ без него был бы «инструментами вообще», а таких
   * не бывает: в двух панелях из разных репозиториев наборы разные.
   *
   * `probe` приходит только с нажатия «Проверить»: проверка связи запускает
   * серверы по-настоящему (`uvx`, `npx`, `uv run` — чужие процессы), и делать
   * это на открытие окна нельзя.
   */
  ipcMain.handle(
    CH.agentMcpStatus,
    async (_e, engine: AgentEngine, requestId: string | undefined, probe?: boolean) => {
      const driver = driverFor(engine)
      if (!driver?.mcpStatus) return { unsupported: true, servers: [] }
      return driver.mcpStatus(requestId, { probe: !!probe })
    }
  )
  ipcMain.handle(
    CH.agentStopTask,
    async (_e, engine: AgentEngine, requestId: string, taskId: string) => {
      const driver = driverFor(engine)
      if (!driver?.stopTask) return { ok: false, reason: 'unsupported' as const }
      return driver.stopTask(requestId, taskId)
    }
  )
  /*
   * Новый состав рабочих папок беседы. Сам список сюда не едет: он придёт со
   * следующим `start`, а это просьба принять его к сведению — иначе состав жил
   * бы в двух местах и однажды разошёлся бы.
   */
  ipcMain.handle(CH.agentApplyDirs, async (_e, engine: AgentEngine, requestId: string) => {
    const driver = driverFor(engine)
    if (!driver?.applyDirectories) return { ok: false, reason: 'unsupported' as const }
    return driver.applyDirectories(requestId)
  })
  /*
   * Здоровье движка. `doctor` — только по нажатию человека: это запуск чужого
   * процесса на несколько секунд, и делать его фоном приложение не вправе.
   */
  ipcMain.handle(
    CH.agentHealth,
    async (_e, engine: AgentEngine, cwd?: string, doctor?: boolean) => {
      const driver = driverFor(engine)
      if (!driver?.engineHealth) return null
      return driver.engineHealth({ cwd, doctor: !!doctor })
    }
  )
  ipcMain.handle(
    CH.agentMcpReconnect,
    async (_e, engine: AgentEngine, requestId: string, name: string) => {
      const driver = driverFor(engine)
      if (!driver?.mcpReconnect) return { ok: false, reason: 'unsupported' as const }
      return driver.mcpReconnect(requestId, name)
    }
  )
  ipcMain.handle(
    CH.agentMcpToggle,
    async (_e, engine: AgentEngine, requestId: string, name: string, enabled: boolean) => {
      const driver = driverFor(engine)
      if (!driver?.mcpToggle) return { ok: false, reason: 'unsupported' as const }
      return driver.mcpToggle(requestId, name, enabled)
    }
  )
  ipcMain.handle(
    CH.agentSkillOverride,
    async (
      _e,
      engine: AgentEngine,
      requestId: string | undefined,
      name: string,
      state: import('@shared/types').SkillState
    ) => {
      const driver = driverFor(engine)
      if (!driver?.skillOverride) return { ok: false, error: 'движок так не умеет' }
      return driver.skillOverride(requestId, name, state)
    }
  )
  /*
   * Счётчик срабатываний. Ходит из окна, потому что вызовы инструментов видит
   * рендерер — у каждого драйвера свой путь событий, а место, где они сходятся
   * все, ровно одно. Данные не покидают машину: это ответ человеку на его же
   * вопрос «за что я плачу, если оно не работает».
   */
  ipcMain.on(CH.agentSkillUsed, (_e, names: unknown) => {
    if (!Array.isArray(names)) return
    // Предел на пачку — не от человека, а от испорченного вызова: файл Зари не
    // должен расти от того, что кто-то прислал тысячу имён разом.
    skillUsageStore.note(names.slice(0, 50).filter((n): n is string => typeof n === 'string'))
  })
  ipcMain.handle(CH.agentSkillUsage, () => skillUsageStore.summary())
  ipcMain.handle(CH.agentSkillUsageClear, () => skillUsageStore.clear())

  ipcMain.handle(CH.agentListCommands, async (_e, engine: AgentEngine, requestId?: string) => {
    const driver = driverFor(engine)
    // Спросили команды — значит панель работает с агентом: самое время начать
    // замечать, что на диске появляется новое. Папку берём У БЕСЕДЫ, а не у
    // процесса: проектные скиллы и `.mcp.json` лежат рядом с кодом панели, а
    // папка запуска приложения к ним отношения не имеет.
    extrasWatcher.watch(requestId ? driver?.sessionCwd?.(requestId) : undefined, () =>
      getWindow()?.webContents.send(CH.agentExtrasChanged)
    )
    if (!driver?.listCommands) return { commands: [], source: 'unknown' }
    try {
      const commands = await driver.listCommands(requestId)
      return { commands, source: 'engine' }
    } catch (e) {
      return {
        commands: [],
        source: 'unknown',
        note: e instanceof Error ? e.message : String(e)
      }
    }
  })
  ipcMain.handle(
    CH.agentDebugFlags,
    (_e, engine: AgentEngine, requestId?: string) =>
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
  ipcMain.handle(CH.historyClear, () => historyStore.clear())
  ipcMain.handle(CH.historyStats, () => historyStore.stats())
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
  ipcMain.handle(
    CH.agentRewindFiles,
    async (
      _e,
      engine: AgentEngine,
      requestId: string,
      userMessageId: string,
      opts?: {
        dryRun?: boolean
        cwd?: string
        resume?: string
        /** Снимок, который человек видел в карточке (для сверки перед записью). */
        seen?: SeenFile[]
        /**
         * Другие живые беседы — чтобы назвать панель, которая держит тот же
         * файл. Список приходит из окна: оно знает, какие панели открыты и как
         * они называются.
         */
        others?: Array<{ id: string; title?: string }>
      }
    ) => {
      const drv = driverFor(engine)
      // Движок так не умеет — это ответ, а не ошибка: интерфейс обязан сказать
      // словами, а не показать кнопку, за которой ничего нет.
      //
      // Спрашиваем СПОСОБНОСТЬ, а не наличие метода: драйверы делят реализацию
      // (фейки — один класс), и «метод существует» не значит «движок умеет».
      const rewind = drv?.rewindFiles?.bind(drv)
      if (!rewind || drv?.capabilities?.rewindFiles !== true) {
        return { canRewind: false, refused: 'unsupported' }
      }
      /*
       * Ответ придёт ВСЕГДА.
       *
       * За этой границей ждёт человек: карточка показывает «Смотрю, что
       * изменится…», пока IPC не вернётся. Драйвер Claude свой предел знает
       * (там он ещё и аренду снимает за собой), но драйверов больше одного, и
       * повиснуть может любой — а карточка про причину не догадается, она
       * просто будет крутиться. Поэтому предел стоит и здесь, выше драйверного:
       * пусть сначала ответит он сам, со своей причиной, и только если
       * промолчал и он — отвечаем мы.
       */
      const call = async (o: Parameters<typeof rewind>[2]): Promise<RewindFilesOutcome> => {
        const r = await Promise.race([
          rewind(requestId, userMessageId, o),
          new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), REWIND_IPC_TIMEOUT_MS))
        ])
        return r === 'timeout' ? { canRewind: false, refused: 'timeout' } : r
      }
      // Та же граница, что и на старте хода: служебный подъём сессии не должен
      // включать копии там, где прогон их не заслужил.
      const allowCheckpoints = checkpointPolicy({
        wanted: settingsStore.get().ai.fileCheckpoints === true,
        isolated: !!process.env.ZARYA_USER_DATA,
        configDirOverridden: !!process.env.CLAUDE_CONFIG_DIR,
        liveOverride: process.env.ZARYA_QA_LIVE_CHECKPOINTS === '1'
      }).on
      try {
        if (opts?.dryRun) {
          // Сухой прогон отдаём как есть, но дополняем тем, чего движок не
          // знает: какие пути он пропустит (ссылки), какие лежат вне папки
          // агента и что вообще есть на диске. Об этом надо сказать ДО, а не
          // числом после.
          const dry = await call({
            dryRun: true,
            resume: opts.resume,
            cwd: opts.cwd,
            checkpoints: allowCheckpoints
          })
          const paths = dry.filesChanged ?? []
          if (!paths.length) return dry
          // Беседа могла быть поднята с диска — тогда карта в памяти пуста, и
          // без этого карточка сказала бы «не ручаемся» о файлах, про которые
          // на самом деле всё знает.
          await agentFileStore.restore(agentFiles, requestId)
          const facts = await diskFacts(paths, opts.cwd ?? '')
          /*
           * К фактам с диска добавляем то, что знаем только мы: что именно
           * записал сюда агент. Без этого карточка не может отличить «файл
           * вернётся к прежнему виду» от «ты потеряешь свою правку» — а движок
           * такую разницу не показывает вовсе и затирает правку молча.
           */
          /*
           * Соседняя панель ищется по ПУТИ, а не по папке.
           *
           * Папочное сравнение врёт дважды: агент из одной папки спокойно
           * пишет в другую (проверено прогоном — файл в чужом проекте), а
           * панель на другом движке при сравнении «внутри Claude» не видна
           * вовсе. Карта общая для всех драйверов, поэтому достаточно
           * спросить её про чужие беседы.
           */
          const others = (opts.others ?? []).filter((o) => o.id !== requestId)
          for (const o of others) await agentFileStore.restore(agentFiles, o.id)
          return {
            ...dry,
            facts: facts.map((f) => {
              const pane = others.find((o) => agentFiles.note(o.id, f.path))
              const note = agentFiles.note(requestId, f.path)
              return {
                ...f,
                ...compareNote(note, f.hash, f.existsNow),
                // Ход, на котором агент создал файл: по нему карточка поймёт,
                // что откат его СОТРЁТ, а не вернёт.
                ...(note?.createdTurnId ? { createdTurnId: note.createdTurnId } : {}),
                ...(pane ? { heldByPane: pane.title || pane.id } : {})
              }
            })
          }
        }
        /*
         * Настоящий откат идёт вместе с пост-сверкой — иначе её однажды забудут.
         *
         * Числам движка нельзя верить как отчёту: часть его промахов не
         * попадает никуда (пропала резервная копия — `skippedLinks` не
         * выставлен, исключения нет, `canRewind:true`). Рапорт «откатили пять
         * файлов» после того, как один остался прежним, — враньё уже ПОСЛЕ
         * необратимого действия. Поэтому снимаем состояние до, откатываем и
         * сверяем сами.
         */
        const plan = await call({
          dryRun: true,
          resume: opts?.resume,
          cwd: opts?.cwd,
          checkpoints: allowCheckpoints
        })
        const paths = plan.filesChanged ?? []
        const before = paths.length ? await diskFacts(paths, opts?.cwd ?? '') : []
        /*
         * Сверка с тем, что человек ВИДЕЛ.
         *
         * Между показом карточки и нажатием проходит время: список читают. За
         * эту минуту файл могли сохранить из редактора, дописать соседней
         * панелью или переписать сборкой. Откатить по устаревшему списку значит
         * стереть то, о чём карточка не сказала — формально не соврали,
         * фактически показали снимок, которого уже нет. Поэтому не пишем, а
         * возвращаем расхождение: карточка перерисуется и потребует НОВОГО
         * нажатия.
         */
        if (opts?.seen?.length) {
          const stale = staleAgainst(
            opts.seen,
            before.map((f) => ({ path: f.path, existsNow: f.existsNow, hash: f.hash }))
          )
          if (stale.length) return { canRewind: false, refused: 'stale', stale }
        }
        /*
         * Страхуем то, что человек рискует потерять НАВСЕГДА.
         *
         * У движка есть «до агента», но нет «до отката»: ручная правка исчезнет
         * без следа, и обратиться будет некуда, если файл не в git. Копируем не
         * всё подряд — только спорное: где содержимое разошлось с тем, что
         * записал агент, и где мы вообще ничего не знаем. Обычно это ноль-три
         * файла.
         */
        await agentFileStore.restore(agentFiles, requestId)
        const risky = before
          .filter((f) => {
            if (!f.existsNow || f.linkSkipped) return false
            const cmp = compareNote(agentFiles.note(requestId, f.path), f.hash, f.existsNow)
            return cmp.changedAfterAgent || !cmp.observed
          })
          .map((f) => f.path)
        const backup = await backupBeforeRewind(requestId, risky)
        /*
         * Копию снять не удалось — откат НЕ выполняем.
         *
         * Страховка существует ровно для этих файлов: у движка есть «до
         * агента», но нет «до отката». Выполнить откат, не сохранив то, что он
         * сотрёт, значит уничтожить работу человека и сообщить об этом после.
         * Причина у каждого файла своя (занят, нет прав, лимит) — и она решает,
         * что человеку делать дальше.
         */
        if (backup.skipped.length) {
          return {
            canRewind: false,
            refused: 'backup-failed',
            backup,
            filesChanged: paths
          }
        }
        const done = await call({
          dryRun: false,
          resume: opts?.resume,
          cwd: opts?.cwd,
          checkpoints: allowCheckpoints
        })
        if (!before.length) return done
        return {
          ...done,
          verdict: await verifyRewind(before, opts?.cwd ?? ''),
          ...(backup.saved ? { backup } : {}),
          // Не поместившееся в лимит называем, а не проглатываем: «сохранили»
          // там, где не сохранили, хуже, чем честное «не сохранили».
          ...(backup.skipped.length && !backup.saved ? { backup } : {})
        }
      } catch (e) {
        /*
         * Граница процессов ловит ВСЁ.
         *
         * Настоящий откат при выключенных чекпоинтах бросает — драйвер это
         * ловит сам, но полагаться на дисциплину каждого драйвера здесь нельзя:
         * непойманное исключение доедет до окна как «Error invoking remote
         * method», то есть как «не получилось» вместо объяснения, и человек
         * пойдёт искать причину сам. Слова движка сохраняем дословно.
         */
        return { canRewind: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
  ipcMain.handle(CH.backupUsage, () => backupUsage())
  ipcMain.handle(CH.backupClear, async () => {
    await clearBackups()
    return backupUsage()
  })
  // Настоящий размер чужой папки, а не наша оценка: цифру, которой человек
  // меряет цену настройки, нельзя писать константой.
  ipcMain.handle(CH.checkpointUsage, async () => ({
    dir: fileHistoryDir(),
    ...(await checkpointUsage())
  }))
  // Папка из командной строки первого запуска — забирается один раз.
  ipcMain.handle(CH.takeFolderArg, () => ctx.takeFolderArgs())
  /*
   * Команда `zarya` в системе. Установка и снятие возвращают ПЕРЕПРОВЕРЕННОЕ
   * состояние: экран показывает то, что в системе есть, а не то, что мы
   * попытались сделать. Разница видна ровно тогда, когда всё пошло не так, —
   * то есть тогда, когда она и нужна.
   */
  ipcMain.handle(CH.cliStatus, () => cliStatus())
  ipcMain.handle(CH.cliInstall, () => cliInstall())
  ipcMain.handle(CH.cliRemove, () => cliRemove())
  ipcMain.handle(CH.pickDirectory, async () => {
    /*
     * ZARYA_PICK_DIR — рубильник для прогонов, как и `ZARYA_STT_PICK_DIR` выше:
     * системный диалог выбора папки не нажимается из Playwright, а проверять
     * надо всё, что ПОСЛЕ него. Ставится только прогоном.
     */
    const forced = process.env.ZARYA_PICK_DIR
    if (forced) return forced
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  /*
   * Сохранить текст в файл, выбранный человеком.
   *
   * Диалог показывает главный процесс: путь выбирает ОС, а не приложение —
   * иначе Заря решала бы за человека, куда класть его же разговор. Возвращаем
   * итоговый путь: интерфейсу нужно сказать, куда именно легло.
   */
  ipcMain.handle(
    CH.saveTextFile,
    async (_e, suggested: string, content: string): Promise<string | null> => {
      const win = getWindow()
      if (!win) return null
      const res = await dialog.showSaveDialog(win, { defaultPath: suggested })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, content, 'utf8')
      return res.filePath
    }
  )
  ipcMain.on(CH.setOpacity, (_e, value: number) => {
    const win = getWindow()
    if (!win) return
    const v = Math.min(1, Math.max(0.3, value))
    win.setOpacity(v)
  })
}
