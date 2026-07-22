import { useUiStore, type SidebarView } from '@/state/uiStore'
import { PixelIcon, type PixelIconName } from './PixelIcon'

const ITEMS: Array<{ view: Exclude<SidebarView, null>; icon: PixelIconName; title: string }> = [
  { view: 'sessions', icon: 'sessions', title: 'Сессии' },
  { view: 'files', icon: 'files', title: 'Файлы' },
  { view: 'workflows', icon: 'workflows', title: 'Workflows' },
  { view: 'history', icon: 'history', title: 'История (Хроника)' }
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
          <PixelIcon name={item.icon} />
        </button>
      ))}
      <div className="zy-activity-spacer" />
      <button
        className={`zy-activity-btn${aiPanelOpen ? ' zy-activity-btn--active' : ''}`}
        title="AI-ассистент (Ctrl+Shift+A)"
        onClick={() => ui.set({ aiPanelOpen: !aiPanelOpen })}
      >
        <PixelIcon name="sputnik" />
      </button>
      <button
        className="zy-activity-btn"
        title="Настройки (Ctrl+,)"
        onClick={() => ui.set({ settingsOpen: true })}
      >
        <PixelIcon name="gear" />
      </button>
    </nav>
  )
}
