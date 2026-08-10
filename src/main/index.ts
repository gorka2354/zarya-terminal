import { BrowserWindow, app, shell, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { CH } from '@shared/ipc'
import type { AgentEngine } from '@shared/types'
import type { AgentDriver } from './agentDriver'
import { AiProxy } from './aiProxy'
import { AcpDriver, ACP_CAPABILITIES, parseAcpArgs } from './acpDriver'
import { ClaudeCodeDriver } from './claudeCodeDriver'
import { CodexDriver } from './codexDriver'
import { FakeAgentDriver } from './fakeAgentDriver'
import { HistoryStore } from './historyStore'
import { flushSkillUsage, registerIpc } from './ipc'
import { PtyManager } from './ptyManager'
import { SessionStore } from './sessionStore'
import { SttService } from './sttService'
import { UpdateService } from './updateService'
import { hardenDir } from './filePerms'
import { APP_VERSION } from './appVersion'
import { bindLang } from './lang'
import { SettingsStore } from './settingsStore'
import { WorkflowStore, builtinResourcesDir } from './workflowStore'

// Same userData in dev and production (dev would otherwise use "Electron").
// ZARYA_USER_DATA isolates a throwaway instance (visual-QA harness / offscreen
// capture) so it never touches the user's real sessions or single-instance lock.
const userDataOverride = process.env.ZARYA_USER_DATA
app.setPath('userData', userDataOverride || join(app.getPath('appData'), 'Zarya'))
const isolatedInstance = !!userDataOverride

let mainWindow: BrowserWindow | null = null
let quitConfirmed = false
/** Пользователь подтвердил установку обновления: после штатного выхода — установщик. */
let installAfterQuit = false
let quitTimer: NodeJS.Timeout | null = null

const settingsStore = new SettingsStore()
const sessionStore = new SessionStore()
const sttService = new SttService()
const updateService = new UpdateService(APP_VERSION)
const historyStore = new HistoryStore()
const workflowStore = new WorkflowStore()
const ptyManager = new PtyManager(() => mainWindow)
const aiProxy = new AiProxy(() => mainWindow)
const claudeCodeDriver = new ClaudeCodeDriver(() => mainWindow)
// Registry of native agent drivers, keyed by engine. Codex/Gemini drivers
// (inc-10/11) register here alongside Claude; the IPC layer routes by engine.
const codexDriver = new CodexDriver(() => mainWindow)
// ACP drivers (inc-11/12). One engine-parameterized AcpDriver class backs
// Gemini, Kimi and Qwen — they all speak the Agent Client Protocol, differing
// only by binary/args. probe() hides a chip unless its CLI is installed;
// ZARYA_<ENGINE>_BIN/ARGS override the binary for the mock harness.
function acpEngine(
  engine: AgentEngine,
  defBin: string,
  defArgs: string[],
  envPrefix: string,
  installHintKey: string
): AcpDriver {
  return new AcpDriver(
    engine,
    {
      bin: process.env[`ZARYA_${envPrefix}_BIN`] || defBin,
      args: parseAcpArgs(process.env[`ZARYA_${envPrefix}_ARGS`], defArgs),
      capabilities: ACP_CAPABILITIES,
      installHintKey
    },
    () => mainWindow
  )
}
const geminiDriver = acpEngine(
  'gemini',
  'gemini',
  ['--acp'],
  'GEMINI',
  'drv.geminiMissing'
)
const kimiDriver = acpEngine(
  'kimi',
  'kimi',
  ['acp'],
  'KIMI',
  'drv.kimiMissing'
)
const qwenDriver = acpEngine(
  'qwen',
  'qwen',
  ['--acp'],
  'QWEN',
  'drv.qwenMissing'
)
const agentRegistry = new Map<AgentEngine, AgentDriver>([
  ['claude-code', claudeCodeDriver],
  ['codex', codexDriver],
  ['gemini', geminiDriver],
  ['kimi', kimiDriver],
  ['qwen', qwenDriver]
])
// QA-only (Ф5): register two scripted drivers with DISTINCT capability profiles
// so the harness can prove the abstraction against non-Claude engines — codex
// (no structured questions, no usage gauge) and gemini (has questions, no
// effort). Gated on ZARYA_FAKE_AGENT so it never ships in real runs.
if (process.env.ZARYA_FAKE_AGENT) {
  agentRegistry.set(
    'codex',
    new FakeAgentDriver(
      'codex',
      {
        models: true,
        modelsWithoutSession: true,
        effort: true,
        bypass: true,
        resumableSessions: true,
        usage: false,
        structuredQuestions: false,
        // Состав инструментов умеет ЭТОТ фейк, а соседний (gemini) — нет:
        // прогон обязан увидеть обе ветки, и список, и честное «движок так не
        // умеет». Про настоящий Codex это ничего не говорит — фейк проверяет
        // абстракцию, а не заявляет о чужом движке.
        mcp: true,
        // Остановку одной задачи умеет ЭТОТ фейк, а соседний (gemini) — нет:
        // прогон обязан увидеть и кнопку, и её отсутствие там, где движок так
        // не умеет. Кнопка, которая не остановит, хуже отсутствующей.
        stopTask: true,
        // Режим плана — тоже только у этого фейка: прогон обязан увидеть, что у
        // соседнего чипа НЕТ вовсе.
        planMode: true,
        // Рабочие папки — тоже только здесь. У соседнего (gemini) панель
        // разрешений обязана сказать «этот движок так не умеет» и не показать
        // кнопку: разрешение, которого движок не получит, обещать нельзя.
        directories: true,
        // И здоровье — тоже только у этого фейка: у соседнего (gemini) вкладка
        // «Движок» обязана сказать «этот движок о себе не рассказывает», а не
        // показать пустой экран, который сам выглядит как поломка.
        health: true
      },
      () => mainWindow
    )
  )
  agentRegistry.set(
    'gemini',
    new FakeAgentDriver(
      'gemini',
      {
        models: true,
        modelsWithoutSession: true,
        effort: false,
        bypass: true,
        resumableSessions: true,
        usage: false,
        structuredQuestions: true,
        // Отмотка отправленного — только у этого фейка: esc-queue-test
        // проверяет на codex обратное (сообщение остаётся с пометкой).
        rewind: true,
        // И картинки — тоже только у него: на codex прогон проверяет отказ.
        images: true
      },
      () => mainWindow
    )
  )
}
const killAllAgents = (): void => agentRegistry.forEach((d) => d.killAll())

function createWindow(): void {
  const settings = settingsStore.get()
  const useAcrylic = process.platform === 'win32' && settings.appearance.acrylic

  mainWindow = new BrowserWindow({
    // Explicit window icon (the pixel «заря») so the taskbar shows it directly,
    // independent of the exe-icon cache. A multi-size .ico with crisp native
    // entries per size → Windows picks the right one instead of blurring.
    icon: join(builtinResourcesDir(), 'zarya-icon.ico'),
    width: 1360,
    height: 860,
    minWidth: 920,
    minHeight: 560,
    frame: false,
    show: false,
    // Matches the default theme's bg so the window never flashes a colour the
    // app doesn't use before the renderer paints.
    backgroundColor: useAcrylic ? undefined : '#0f0f0e',
    ...(useAcrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })

  let shown = false
  const reveal = (): void => {
    if (shown || !mainWindow) return
    shown = true
    /*
     * ТИХИЙ ПРОГОН. Окно нужно показать — иначе Chromium не рисует, и снимки
     * выходят пустыми, — но показывать его человеку незачем: за день прогоны
     * запускаются десятки раз, и каждый отбирает фокус посреди работы.
     * Уводим за край экрана: система считает окно видимым, человек — нет.
     */
    if (process.env.ZARYA_QA_OFFSCREEN) {
      const win = mainWindow
      win.setSkipTaskbar(true)
      win.showInactive()
      const park = (): void => {
        // Сравниваем перед сдвигом: setPosition сам поднимает 'move', и без
        // проверки получился бы бесконечный круг.
        if (win.isDestroyed()) return
        if (win.getPosition()[0] > -30000) win.setPosition(-32000, -32000)
      }
      // Прогоны задают размер и зовут center() — это вернуло бы окно человеку
      // на экран посреди его работы. Возвращаем за край.
      win.on('move', park)
      park()
      return
    }
    mainWindow.show()
    const opacity = settingsStore.get().appearance.windowOpacity
    if (opacity < 1) mainWindow.setOpacity(Math.max(0.3, opacity))
  }
  mainWindow.on('ready-to-show', reveal)
  // Safety net: never leave the user with an invisible window.
  setTimeout(reveal, 3000)

  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) {
        console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
      }
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer] gone:', details.reason)
    })
  }

  const sendMaximized = (): void => {
    mainWindow?.webContents.send(CH.windowMaximized, mainWindow.isMaximized())
  }
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  // Graceful shutdown: ask the renderer to snapshot all sessions first.
  mainWindow.on('close', (e) => {
    if (quitConfirmed) return
    e.preventDefault()
    mainWindow?.webContents.send(CH.prepareQuit, { reason: 'close' })
    quitTimer = setTimeout(() => {
      // Renderer did not answer in time — quit anyway (autosave has recent
      // data). 8s gives snapshotAll/prune (session persistence) realistic
      // room to finish instead of being cut off mid-write by a tight 2s cap.
      quitConfirmed = true
      mainWindow?.destroy()
    }, 8000)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // SECURITY: the top frame must only ever render our own dev-server / file://
  // origin. The preload exposes window.zarya (pty.write, fs read/write/delete,
  // etc.), so a remote page loaded in this frame would run with full RCE
  // capability. Block any off-origin navigation and route external URLs to the
  // system browser instead (Electron security checklist #13). No in-app flow
  // navigates the top frame today — this is a preventive guard against a future
  // stray location assignment or an anchor that slips past the click handlers.
  // Our own renderer document, as an exact URL. `file://` as a whole is NOT our
  // origin: accepting any file: URL let a single relative link in agent-rendered
  // markdown (e.g. <a href="payload.html">, resolved against our own file: URL)
  // navigate the top frame to an attacker-supplied local page — which then runs
  // with the full preload API (pty.write, fs, agent control), i.e. RCE past every
  // approval gate. DOMPurify strips `file:` hrefs but not relative ones, so the
  // block has to live here, at the navigation boundary.
  const appFileUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const isOwnOrigin = (url: string): boolean => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev) {
      // Dev server: compare parsed origins, never a bare prefix — the prefix
      // form accepted 'http://localhost:5920@evil.com/' as our own.
      try {
        return new URL(url).origin === new URL(dev).origin
      } catch {
        return false
      }
    }
    // Production: only the exact document we loaded (query/hash allowed, so a
    // reload with '?x' or an in-page anchor still passes).
    const bare = url.split(/[?#]/)[0]
    return bare === appFileUrl
  }
  const guardNavigation = (e: Electron.Event, url: string): void => {
    if (isOwnOrigin(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)

  // A renderer reload (dev HMR full-reload, Ctrl+R) re-boots the workspace and
  // respawns sessions — orphaned ptys from the previous page must not linger.
  mainWindow.webContents.on('did-navigate', () => {
    ptyManager.killAll()
    killAllAgents()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL
    let attempts = 0
    const tryLoad = (): void => {
      attempts++
      mainWindow?.loadURL(url).catch(() => {
        // Vite dev server may still be starting — retry a few times.
        if (attempts < 20) setTimeout(tryLoad, 400)
      })
    }
    tryLoad()
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = isolatedInstance || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    await settingsStore.init()
    // Тексты главного процесса берут язык из тех же настроек, что и окно.
    bindLang(settingsStore)

    registerIpc({
      getWindow: () => mainWindow,
      ptyManager,
      settingsStore,
      sessionStore,
      historyStore,
      workflowStore,
      aiProxy,
      agentRegistry,
      stt: sttService,
      updates: updateService,
      requestQuitConfirmed: () => {
        if (quitTimer) clearTimeout(quitTimer)
        quitConfirmed = true
        settingsStore.flush()
        if (installAfterQuit) {
          // Сессии сняты, настройки на диске — теперь можно отдавать управление
          // установщику. Он погасит процесс сам и поднимет приложение обратно.
          installAfterQuit = false
          updateService.runInstaller()
          return
        }
        mainWindow?.destroy()
      }
    })

    // Установка обновления идёт ТЕМ ЖЕ путём, что и обычное закрытие: рендерер
    // снимает сессии, настройки сбрасываются, pty и агенты гасятся. Обновление
    // не должно стоить человеку открытых терминалов.
    updateService.onQuitForInstall(() => {
      installAfterQuit = true
      if (quitConfirmed) {
        updateService.runInstaller()
        return
      }
      mainWindow?.close()
    })

    // История: применяем настройки сразу и на каждое изменение. Выключатель
    // должен срабатывать немедленно, а не со следующего запуска.
    historyStore.configure(settingsStore.get().history)
    sttService.select(settingsStore.get().voice.modelId)
    sttService.setCustom(settingsStore.get().voice.customModels ?? [])

    // Каталог с данными — только владельцу. Внутри лежат ключи провайдеров,
    // история команд и переписки с агентом. На Windows это почти no-op (там
    // ACL), смысл в Linux и macOS.
    void hardenDir(app.getPath('userData'))

    // Проверка обновлений — один анонимный запрос при запуске, и только если
    // это разрешено настройкой. Ошибка сети сюда не всплывает: сервис держит её
    // в своём состоянии строкой, а не роняет старт приложения.
    // ZARYA_NO_UPDATE_CHECK — рубильник для прогонов: они подставляют состояние
    // релиза сами, а живой ответ GitHub приходил бы поверх подставленного и
    // гасил проверяемый экран. Заодно прогон перестаёт зависеть от сети.
    if (settingsStore.get().updates.check && !process.env.ZARYA_NO_UPDATE_CHECK) {
      void updateService.check()
    }

    // Убрать за прошлым обновлением. electron-updater оставляет в своём кеше
    // ДВЕ копии установщика — на нашей сборке это 365 МБ после каждого
    // обновления. Чистится только то, что старше установленной версии: скачанное
    // и ещё не поставленное обновление трогать нельзя.
    void updateService.cleanCache().then((freed) => {
      if (freed > 0) console.log(`[updates] freed ${Math.round(freed / 1e6)} MB of cache`)
    })

    settingsStore.onChange((s) => {
      historyStore.configure(s.history)
      sttService.select(s.voice.modelId)
      sttService.setCustom(s.voice.customModels ?? [])
      mainWindow?.webContents.send(CH.settingsChanged, s)
    })

    // SECURITY: without a handler Electron GRANTS permission requests by
    // default. Dictation adds a microphone to an app that already has a
    // terminal and a file tree, so the surface gets an explicit allow-list:
    // media and clipboard (the app pastes into terminals), for OUR window only —
    // everything else is denied.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const ours = !!mainWindow && wc === mainWindow.webContents
      const allowed = permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
      callback(ours && allowed)
    })
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      const ours = !!mainWindow && wc === mainWindow.webContents
      return ours && (permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
    })

    createWindow()

    // Keep the fuel gauge honest from boot: poll /usage in the background (a
    // throwaway idle session when no chat is live) instead of only after the
    // first prompt. No-ops on API-key sessions where rate limits don't apply.
    claudeCodeDriver.startAmbientUsagePoll()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    ptyManager.killAll()
    killAllAgents()
    app.quit()
  })

  app.on('before-quit', () => {
    ptyManager.killAll()
    killAllAgents() // else the agent's child subprocess is orphaned on quit
    // Flush any settings edit made within the last debounce window (250ms)
    // so it isn't lost on quit.
    settingsStore.flush()
    // То же для счётчика скиллов: он копится пачками, и без этого терялась бы
    // последняя минута работы — как раз та, ради которой человек и смотрит.
    void flushSkillUsage()
  })
}
