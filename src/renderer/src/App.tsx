import { installKeyRouter } from '@/features/ai/keyRouter'
import { installWaitingCall } from '@/features/ai/waitingCall'
import { installLongCommandCall } from '@/terminal/longCommandCall'
import { t } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { registerCoreActions } from '@/actions/coreActions'
import { openProject } from '@/actions/projects'
import { registerDeskActions } from '@/actions/deskActions'
import { ActivityBar } from '@/components/ActivityBar'
import { BottomStrip } from '@/components/BottomStrip'
import { BlocksPanel } from '@/components/BlocksPanel'
import { LaunchPad } from '@/components/LaunchPad'
import { AskText } from '@/components/AskText'
import { ModelNews } from '@/components/ModelNews'
import { MissionFeed } from '@/components/MissionFeed'
import { SessionsPanel } from '@/components/SessionsPanel'
import { PanesHost } from '@/components/SplitLayout'
import { StatusBar } from '@/components/StatusBar'
import { Titlebar } from '@/components/Titlebar'
import { Toasts } from '@/components/Toasts'
import AiCommandBar from '@/features/ai/AiCommandBar'
import AiPanel from '@/features/ai/AiPanel'
import EditorPane from '@/features/editor/EditorPane'
import FileTree from '@/features/editor/FileTree'
import { useEditorStore } from '@/features/editor/editorStore'
import HistoryOverlay from '@/features/history/HistoryOverlay'
import HistoryPanel from '@/features/history/HistoryPanel'
import CommandPalette from '@/features/palette/CommandPalette'
import QuickOpen from '@/features/palette/QuickOpen'
import { initKeybindings } from '@/features/palette/keybindings'
import SettingsView from '@/features/settings/SettingsView'
import { Onboarding } from '@/features/onboarding/Onboarding'
import UpdateView from '@/features/updates/UpdateView'
import { useContextMenu, type MenuItem } from '@/components/ContextMenu'
import { useUpdateStore } from '@/features/updates/updateStore'
import { applyTheme, getTheme } from '@/features/themes/themes'
import WorkflowsPanel from '@/features/workflows/WorkflowsPanel'
import { Icon } from '@/components/Icon'
import logoZarya from '@/assets/logo-zarya-64.png'
import { seedHistoryCache } from '@/terminal/historyCache'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { isRaw, useUiStore } from '@/state/uiStore'
import { useAiStore } from '@/features/ai/aiStore'

export default function App(): React.JSX.Element {
  // Единственный слушатель Esc/Enter на окно. Панели не слушают окно сами —
  // иначе одно нажатие обслужат все, и один Enter одобрит несколько команд.
  useEffect(() => installKeyRouter(), [])
  // Зов к панели, которая встала: только когда окно не в фокусе (см. модуль).
  useEffect(() => installWaitingCall(), [])
  // Зов о законченной долгой команде — по тем же правилам, что и зов агента.
  useEffect(() => installLongCommandCall(), [])
  const [booted, setBooted] = useState(false)
  // QA-хук: открыть контекстное меню с заданными пунктами. Меню — общий
  // компонент, и его геометрия (влезает ли в окно, прокручивается ли длинный
  // список) не должна зависеть от того, сколько сессий лежит на конкретной
  // машине. Безвреден в проде: без вызова ничего не рисует.
  const { menu: testMenu, open: openTestMenu } = useContextMenu()
  useEffect(() => {
    ;(
      window as unknown as {
        __zaryaTestMenu?: (items: MenuItem[], at?: { x: number; y: number }) => void
      }
    ).__zaryaTestMenu = (items, at) => openTestMenu(at?.x ?? 40, at?.y ?? 60, items)
  }, [openTestMenu])

  const bootStarted = useRef(false)

  useEffect(() => {
    if (bootStarted.current) return
    bootStarted.current = true
    void (async () => {
      await useSettingsStore.getState().init()
      applyTheme(getTheme(useSettingsStore.getState().settings.appearance.themeId))
      registerCoreActions()
      // Столы — отдельным списком: он меняется вместе с ними, а не один раз
      // при запуске.
      registerDeskActions()
      initKeybindings()
      void seedHistoryCache()
      // Состояние проверки обновлений считает main; окно только подписывается.
      useUpdateStore.getState().init()
      window.zarya.app.onMaximized((maximized) => useUiStore.getState().set({ maximized }))
      await useSessionsStore.getState().boot()
      // Restore persisted agent conversations (each bound to its terminal),
      // after sessions so the session ids they reference are back.
      await useAiStore.getState().hydrate()
      /*
       * Папка из командной строки (`zarya .`).
       *
       * Подписываемся ПОСЛЕ восстановления сессий: вкладка проекта должна
       * встать поверх восстановленного стола, а не потеряться под ним. Главный
       * процесс придерживает сообщение до конца загрузки окна, поэтому первый
       * запуск с папкой сюда доходит.
       *
       * Путь назвали, а открыть нечем — говорим словами. Молча открыть вместо
       * него домашнюю папку значило бы сделать не то, о чём попросили.
       */
      const useFolderArg = (msg: { dir?: string; bad?: string } | null): void => {
        if (!msg) return
        if (msg.dir) void openProject(msg.dir)
        else if (msg.bad) useUiStore.getState().toast(t('cli.noFolder', { path: msg.bad }), 'error')
      }
      // Папку ПЕРВОГО запуска забираем сами: главный процесс не знает, когда мы
      // готовы её открыть, и толкнутое сообщение ушло бы в пустоту.
      for (const msg of (await window.zarya.app.takeFolderArg()) ?? []) useFolderArg(msg)
      // Второй запуск отдаёт свою папку на лету — тут подписка уже стоит.
      window.zarya.app.onOpenFolderArg(useFolderArg)
      setBooted(true)
    })()
  }, [])

  // react to theme / opacity changes
  const themeId = useSettingsStore((s) => s.settings.appearance.themeId)
  const opacity = useSettingsStore((s) => s.settings.appearance.windowOpacity)
  useEffect(() => {
    applyTheme(getTheme(themeId))
  }, [themeId])

  // «Размер шрифта» has to reach what the user is actually looking at. It used
  // to be handed to xterm only — but xterm renders offscreen while the mission
  // feed is on screen, so changing it appeared to do nothing at all. Publishing
  // it as a CSS variable lets the feed scale its terminal text with the same
  // dial. Chrome/UI labels deliberately stay fixed: this is a terminal zoom, not
  // an application zoom.
  const fontSize = useSettingsStore((s) => s.settings.appearance.fontSize)
  const lineHeight = useSettingsStore((s) => s.settings.appearance.lineHeight)
  const termPadding = useSettingsStore((s) => s.settings.appearance.terminalPadding)
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--term-font-size', `${fontSize}px`)
    root.style.setProperty('--term-line-height', String(lineHeight))
    root.style.setProperty('--term-padding', `${termPadding}px`)
  }, [fontSize, lineHeight, termPadding])
  useEffect(() => {
    window.zarya.app.setOpacity(opacity)
  }, [opacity])

  if (!booted) {
    return (
      <div className="zy-splash">
        <div className="zy-splash-mark">
          <img
            src={logoZarya}
            width={48}
            height={48}
            style={{ imageRendering: 'pixelated' }}
            alt=""
          />
        </div>
        <div className="zy-splash-text">{t('splash')}</div>
      </div>
    )
  }

  return (
    <div
      className="zy-app"
      onDragOver={(e) => {
        // Allow dropping a folder to open a terminal there.
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        const path = window.zarya.app.getPathForFile(file)
        if (!path) return
        void window.zarya.fs.stat(path).then((st) => {
          const dir = st?.isDir ? path : path.replace(/[\\/][^\\/]*$/, '')
          if (dir) {
            void useSessionsStore.getState().newTab(undefined, dir)
            useUiStore.getState().toast(t('sess.openedIn', { dir }), 'success')
          }
        })
      }}
    >
      <Titlebar />
      <div className="zy-main">
        <ActivityBar />
        <Sidebar />
        <MainContent />
        <RightPanels />
      </div>
      <StatusBar />
      {/* overlays */}
      <CommandPalette />
      <QuickOpen />
      <HistoryOverlay />
      <AiCommandBar />
      <SettingsView />
      <UpdateView />
      {testMenu}
      <LaunchPad />
      <AskText />
      <ModelNews />
      {/* Первый экран. Поверх всего и до всего: пока он открыт, знакомство
          важнее любого другого окна — но Esc и «Пропустить» закрывают его
          навсегда. */}
      <Onboarding />
      <Toasts />
    </div>
  )
}

function Sidebar(): React.JSX.Element | null {
  const view = useUiStore((s) => s.sidebarView)
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  if (!view) return null
  // Files/Workflows are IDE-only; fall back to Sessions if the IDE layer is off.
  const ideView = view === 'files' || view === 'workflows'
  if (ideView && !ideMode)
    return (
      <aside className="zy-sidebar">
        <SessionsPanel />
      </aside>
    )
  return (
    <aside className="zy-sidebar">
      {view === 'sessions' && <SessionsPanel />}
      {view === 'files' && <FileTree />}
      {view === 'workflows' && <WorkflowsPanel />}
      {view === 'history' && <HistoryPanel />}
    </aside>
  )
}

function MainContent(): React.JSX.Element {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId())
  // Сырой режим — по панели; здесь читается режим АКТИВНОЙ, потому что от него
  // зависит только фон рабочей области.
  const rawTerminal = useUiStore((s) => isRaw(s, activeSessionId))
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  const editorFiles = useEditorStore((s) => s.files)
  const [editorWidth, setEditorWidth] = useState(46) // percent
  // The Monaco editor is part of the IDE superstructure — only when enabled.
  const editorOpen = ideMode && editorFiles.length > 0

  return (
    <div className="zy-content">
      <div className="zy-terminal-col">
        <div className="zy-workspace">
          {/* The live xterm(s): PTY I/O, shell integration (OSC 133), output
              capture. Visible & typeable in «Терминал» mode (run vim/claude/…);
              in «Блоки» mode it sits behind the opaque mission-feed overlay and
              is display-only. */}
          <div className={`zy-engine-host${rawTerminal ? ' zy-engine-host--raw' : ''}`}>
            {/* Все панели всех вкладок — одним плоским списком: место панели в
                разметке больше не зависит от раскладки, и перестройка дерева не
                пересоздаёт терминал (см. SplitLayout / paneTree). */}
            <PanesHost />
          </div>
          {/* Лента теперь рисуется КАЖДОЙ панелью (TerminalPane): иначе четыре
              панели показывали бы один разговор, а сплиты были бы не видны. */}
          {!activeSessionId && (
            <div className="zy-empty" style={{ margin: 'auto' }}>
              {t('workspace.empty')}
            </div>
          )}
        </div>
        {/* Строка ввода живёт в КАЖДОЙ панели (TerminalPane). Внизу окна
            остаётся только общее: топливомер подписки и счётчик панелей,
            ждущих решения. */}
        <BottomStrip />
      </div>
      {editorOpen && (
        <>
          <EditorGutter onResize={setEditorWidth} />
          <div className="zy-editor-split" style={{ width: `${editorWidth}%` }}>
            <EditorPane />
          </div>
        </>
      )}
    </div>
  )
}

function EditorGutter({ onResize }: { onResize: (pct: number) => void }): React.JSX.Element {
  return (
    <div
      className="zy-split-gutter zy-split-gutter--row"
      onPointerDown={(e) => {
        e.preventDefault()
        const parent = (e.currentTarget as HTMLElement).parentElement
        if (!parent) return
        const rect = parent.getBoundingClientRect()
        const move = (ev: PointerEvent): void => {
          const pct = ((rect.right - ev.clientX) / rect.width) * 100
          onResize(Math.min(75, Math.max(20, pct)))
        }
        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    />
  )
}

function RightPanels(): React.JSX.Element {
  const blocksOpen = useUiStore((s) => s.blocksPanelOpen)
  const aiOpen = useUiStore((s) => s.aiPanelOpen)
  // The IDE-agent (second pilot, own API key) is part of the IDE superstructure.
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  return (
    <>
      {blocksOpen && (
        <aside className="zy-sidebar zy-sidebar--right">
          <BlocksPanel />
        </aside>
      )}
      {ideMode &&
        (aiOpen ? (
          <aside className="zy-sidebar zy-sidebar--right zy-sidebar--ai">
            <AiPanel />
          </aside>
        ) : (
          <aside className="zy-ide-rail">
            <button
              className="zy-ide-rail-btn"
              title={t('ide.open')}
              onClick={() => useUiStore.getState().set({ aiPanelOpen: true })}
            >
              <Icon name="sputnik" size={16} strokeWidth={1.5} />
            </button>
            <span className="zy-ide-rail-label">{t('ide.label')}</span>
          </aside>
        ))}
    </>
  )
}
