import { useEffect, useRef, useState } from 'react'
import { registerCoreActions } from '@/actions/coreActions'
import { ActivityBar } from '@/components/ActivityBar'
import { AgentBar } from '@/components/AgentBar'
import { BlocksPanel } from '@/components/BlocksPanel'
import { LaunchPad } from '@/components/LaunchPad'
import { MissionFeed } from '@/components/MissionFeed'
import { StarBackdrop } from '@/components/StarBackdrop'
import { SessionsPanel } from '@/components/SessionsPanel'
import { SplitLayout } from '@/components/SplitLayout'
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
import { applyTheme, getTheme } from '@/features/themes/themes'
import WorkflowsPanel from '@/features/workflows/WorkflowsPanel'
import { Icon } from '@/components/Icon'
import logoZarya from '@/assets/logo-zarya-64.png'
import { seedHistoryCache } from '@/terminal/historyCache'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useAiStore } from '@/features/ai/aiStore'

export default function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const bootStarted = useRef(false)

  useEffect(() => {
    if (bootStarted.current) return
    bootStarted.current = true
    void (async () => {
      await useSettingsStore.getState().init()
      applyTheme(getTheme(useSettingsStore.getState().settings.appearance.themeId))
      registerCoreActions()
      initKeybindings()
      void seedHistoryCache()
      window.zarya.app.onMaximized((maximized) => useUiStore.getState().set({ maximized }))
      await useSessionsStore.getState().boot()
      // Restore persisted agent conversations (each bound to its terminal),
      // after sessions so the session ids they reference are back.
      await useAiStore.getState().hydrate()
      setBooted(true)
    })()
  }, [])

  // react to theme / opacity changes
  const themeId = useSettingsStore((s) => s.settings.appearance.themeId)
  const opacity = useSettingsStore((s) => s.settings.appearance.windowOpacity)
  useEffect(() => {
    applyTheme(getTheme(themeId))
  }, [themeId])
  useEffect(() => {
    window.zarya.app.setOpacity(opacity)
  }, [opacity])

  if (!booted) {
    return (
      <div className="zy-splash">
        <div className="zy-splash-mark">
          <img src={logoZarya} width={48} height={48} style={{ imageRendering: 'pixelated' }} alt="" />
        </div>
        <div className="zy-splash-text">Заря · подготовка к старту</div>
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
            useUiStore.getState().toast(`Терминал в ${dir}`, 'success')
          }
        })
      }}
    >
      <StarBackdrop />
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
      <LaunchPad />
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
  if (ideView && !ideMode) return <aside className="zy-sidebar"><SessionsPanel /></aside>
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
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId())
  const rawTerminal = useUiStore((s) => s.rawTerminal)
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
            {tabs.map((tab) => (
              <SplitLayout key={tab.id} tab={tab} visible={tab.id === activeTabId} />
            ))}
          </div>
          {!rawTerminal &&
            (activeSessionId ? (
              <MissionFeed sessionId={activeSessionId} />
            ) : (
              <div className="zy-empty" style={{ margin: 'auto' }}>
                Открой терминал кнопкой + в сайдбаре (Ctrl+Shift+T)
              </div>
            ))}
        </div>
        {/* Hidden in «Терминал» mode: a raw TUI (claude/vim/ssh) owns the input,
            so a second bar here would be a confusing double input. */}
        {!rawTerminal && <AgentBar />}
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
              title="Открыть IDE-агента (второй пилот · свой ключ)"
              onClick={() => useUiStore.getState().set({ aiPanelOpen: true })}
            >
              <Icon name="sputnik" size={16} strokeWidth={1.5} />
            </button>
            <span className="zy-ide-rail-label">IDE-АГЕНТ</span>
          </aside>
        ))}
    </>
  )
}
