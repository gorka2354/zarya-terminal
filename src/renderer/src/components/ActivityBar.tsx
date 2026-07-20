import { useUiStore, type SidebarView } from '@/state/uiStore'

const ITEMS: Array<{ view: Exclude<SidebarView, null>; icon: string; title: string }> = [
  { view: 'sessions', icon: '▤', title: 'Сессии' },
  { view: 'files', icon: '🗀', title: 'Файлы' },
  { view: 'workflows', icon: '⚡', title: 'Workflows' },
  { view: 'history', icon: '🕘', title: 'История (Time Machine)' }
]

export function ActivityBar(): React.JSX.Element {
  const sidebarView = useUiStore((s) => s.sidebarView)
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen)
  const ui = useUiStore.getState()

  return (
    <nav className="zy-activitybar">
      {ITEMS.map((item) => (
        <button
          key={item.view}
          className={`zy-activity-btn${sidebarView === item.view ? ' zy-activity-btn--active' : ''}`}
          title={item.title}
          onClick={() => ui.toggleSidebar(item.view)}
        >
          {item.icon}
        </button>
      ))}
      <div className="zy-activity-spacer" />
      <button
        className={`zy-activity-btn${aiPanelOpen ? ' zy-activity-btn--active' : ''}`}
        title="AI-ассистент (Ctrl+Shift+A)"
        onClick={() => ui.set({ aiPanelOpen: !aiPanelOpen })}
      >
        ✦
      </button>
      <button
        className="zy-activity-btn"
        title="Настройки (Ctrl+,)"
        onClick={() => ui.set({ settingsOpen: true })}
      >
        ⚙
      </button>
    </nav>
  )
}
