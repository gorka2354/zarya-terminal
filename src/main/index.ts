import { BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { CH } from '@shared/ipc'
import type { AgentEngine } from '@shared/types'
import type { AgentDriver } from './agentDriver'
import { AiProxy } from './aiProxy'
import { AcpDriver, ACP_CAPABILITIES, parseAcpArgs } from './acpDriver'
import { ClaudeCodeDriver } from './claudeCodeDriver'
import { CodexDriver } from './codexDriver'
import { FakeAgentDriver } from './fakeAgentDriver'
import { HistoryStore } from './historyStore'
import { registerIpc } from './ipc'
import { PtyManager } from './ptyManager'
import { SessionStore } from './sessionStore'
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
let quitTimer: NodeJS.Timeout | null = null

const settingsStore = new SettingsStore()
const sessionStore = new SessionStore()
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
  installHint: string
): AcpDriver {
  return new AcpDriver(
    engine,
    {
      bin: process.env[`ZARYA_${envPrefix}_BIN`] || defBin,
      args: parseAcpArgs(process.env[`ZARYA_${envPrefix}_ARGS`], defArgs),
      capabilities: ACP_CAPABILITIES,
      installHint
    },
    () => mainWindow
  )
}
const geminiDriver = acpEngine(
  'gemini',
  'gemini',
  ['--acp'],
  'GEMINI',
  'Gemini CLI не найден. Установи `npm i -g @google/gemini-cli`, затем войди в аккаунт.'
)
const kimiDriver = acpEngine(
  'kimi',
  'kimi',
  ['acp'],
  'KIMI',
  'Kimi CLI не найден. Установи Kimi Code CLI (`kimi`) и выполни `kimi /login`.'
)
const qwenDriver = acpEngine(
  'qwen',
  'qwen',
  ['--acp'],
  'QWEN',
  'Qwen Code не найден. Установи `npm i -g @qwen-code/qwen-code`, затем войди в аккаунт.'
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
        structuredQuestions: false
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
        structuredQuestions: true
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
    backgroundColor: useAcrylic ? undefined : '#0b0f1a',
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
  const isOwnOrigin = (url: string): boolean => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return true
    return url.startsWith('file://')
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

    registerIpc({
      getWindow: () => mainWindow,
      ptyManager,
      settingsStore,
      sessionStore,
      historyStore,
      workflowStore,
      aiProxy,
      agentRegistry,
      requestQuitConfirmed: () => {
        if (quitTimer) clearTimeout(quitTimer)
        quitConfirmed = true
        settingsStore.flush()
        mainWindow?.destroy()
      }
    })

    settingsStore.onChange((s) => {
      mainWindow?.webContents.send(CH.settingsChanged, s)
    })

    createWindow()

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
  })
}
