import { useEffect, useRef, useState } from 'react'
import { registerCoreActions } from '@/actions/coreActions'
import { ActivityBar } from '@/components/ActivityBar'
import { AgentBar } from '@/components/AgentBar'
import { BlocksPanel } from '@/components/BlocksPanel'
import { LaunchPad } from '@/components/LaunchPad'
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
import { seedHistoryCache } from '@/terminal/historyCache'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'

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
          <Icon name="rocket" size={34} strokeWidth={1.4} />
        </div>
        <div className="zy-splash-text">Заря · подготовка к старту</div>
      </div>
    )
  }

  return (
    <div className="zy-app">
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
  if (!view) return null
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
  const editorFiles = useEditorStore((s) => s.files)
  const [editorWidth, setEditorWidth] = useState(46) // percent
  const editorOpen = editorFiles.length > 0

  return (
    <div className="zy-content">
      <div className="zy-terminal-col">
        <div className="zy-workspace">
          {tabs.map((tab) => (
            <SplitLayout key={tab.id} tab={tab} visible={tab.id === activeTabId} />
          ))}
          {!tabs.length && (
            <div className="zy-empty" style={{ margin: 'auto' }}>
              Нет открытых сессий — создай новую вкладку (Ctrl+Shift+T)
            </div>
          )}
        </div>
        <AgentBar />
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
  return (
    <>
      {blocksOpen && (
        <aside className="zy-sidebar zy-sidebar--right">
          <BlocksPanel />
        </aside>
      )}
      {aiOpen ? (
        <aside className="zy-sidebar zy-sidebar--right zy-sidebar--ai">
          <AiPanel />
        </aside>
      ) : (
        <aside className="zy-ide-rail">
          <button
            className="zy-ide-rail-btn"
            title="Открыть IDE-агента (второй пилот)"
            onClick={() => useUiStore.getState().set({ aiPanelOpen: true })}
          >
            <Icon name="sputnik" size={16} strokeWidth={1.5} />
          </button>
          <span className="zy-ide-rail-label">IDE-АГЕНТ</span>
        </aside>
      )}
    </>
  )
}
