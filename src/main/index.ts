import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { CH } from '@shared/ipc'
import { AiProxy } from './aiProxy'
import { HistoryStore } from './historyStore'
import { registerIpc } from './ipc'
import { PtyManager } from './ptyManager'
import { SessionStore } from './sessionStore'
import { SettingsStore } from './settingsStore'
import { WorkflowStore } from './workflowStore'

// Same userData in dev and production (dev would otherwise use "Electron").
app.setPath('userData', join(app.getPath('appData'), 'Zarya'))

let mainWindow: BrowserWindow | null = null
let quitConfirmed = false
let quitTimer: NodeJS.Timeout | null = null

const settingsStore = new SettingsStore()
const sessionStore = new SessionStore()
const historyStore = new HistoryStore()
const workflowStore = new WorkflowStore()
const ptyManager = new PtyManager(() => mainWindow)
const aiProxy = new AiProxy(() => mainWindow)

function createWindow(): void {
  const settings = settingsStore.get()
  const useAcrylic = process.platform === 'win32' && settings.appearance.acrylic

  mainWindow = new BrowserWindow({
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
      // Renderer did not answer in time — quit anyway (autosave has recent data).
      quitConfirmed = true
      mainWindow?.destroy()
    }, 2000)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // A renderer reload (dev HMR full-reload, Ctrl+R) re-boots the workspace and
  // respawns sessions — orphaned ptys from the previous page must not linger.
  mainWindow.webContents.on('did-navigate', () => {
    ptyManager.killAll()
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

const gotLock = app.requestSingleInstanceLock()
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
      requestQuitConfirmed: () => {
        if (quitTimer) clearTimeout(quitTimer)
        quitConfirmed = true
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
    app.quit()
  })

  app.on('before-quit', () => {
    ptyManager.killAll()
  })
}
