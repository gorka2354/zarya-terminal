import { useUiStore, type SidebarView } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { toggleIdeMode } from '@/features/ide/ideMode'
import { hasUpdate, useUpdateStore } from '@/features/updates/updateStore'
import { PixelIcon, type PixelIconName } from './PixelIcon'

type Item = { view: Exclude<SidebarView, null>; icon: PixelIconName; title: string }
// Base views are always present; IDE views only when the IDE layer is enabled.
const BASE_ITEMS: Item[] = [
  { view: 'sessions', icon: 'sessions', title: 'Сессии' },
  { view: 'history', icon: 'history', title: 'История (Хроника)' }
]
const IDE_ITEMS: Item[] = [
  { view: 'files', icon: 'files', title: 'Файлы (IDE)' },
  { view: 'workflows', icon: 'workflows', title: 'Workflows (IDE)' }
]

export function ActivityBar(): React.JSX.Element {
  const sidebarView = useUiStore((s) => s.sidebarView)
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen)
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  const upd = useUpdateStore((s) => s.state)
  const ui = useUiStore.getState()

  const btn = (item: Item): React.JSX.Element => (
    <button
      key={item.view}
      className={`zy-activity-btn${sidebarView === item.view ? ' zy-activity-btn--active' : ''}`}
      title={item.title}
      onClick={() => ui.toggleSidebar(item.view)}
    >
      <PixelIcon name={item.icon} />
    </button>
  )

  return (
    <nav className="zy-activitybar">
      {BASE_ITEMS.map(btn)}
      {ideMode && <div className="zy-activity-divider" />}
      {ideMode && IDE_ITEMS.map(btn)}
      <div className="zy-activity-spacer" />
      {ideMode && (
        <button
          className={`zy-activity-btn${aiPanelOpen ? ' zy-activity-btn--active' : ''}`}
          title="IDE-агент · второй пилот (Ctrl+Shift+A)"
          onClick={() => ui.set({ aiPanelOpen: !aiPanelOpen })}
        >
          <PixelIcon name="sputnik" />
        </button>
      )}
      <button
        className={`zy-activity-btn zy-activity-ide${ideMode ? ' zy-activity-ide--on' : ''}`}
        title={ideMode ? 'IDE-надстройка ВКЛ — нажми, чтобы вернуть чистую базу' : 'Включить IDE-надстройку (Файлы, Редактор, Workflows, IDE-агент)'}
        onClick={toggleIdeMode}
      >
        <PixelIcon name={ideMode ? 'files' : 'folder'} />
      </button>
      {/* Кнопка появляется только когда есть что предлагать, и исчезает после
          обновления. Постоянный «проверить обновления» в панели занимал бы место
          ради действия, которое нужно раз в месяц; молчаливая точка на шестерне —
          наоборот, слишком тихо для выхода security-фикса. */}
      {hasUpdate(upd) && (
        <button
          className="zy-activity-btn zy-activity-upd"
          title={`Доступно обновление ${upd?.latest?.version} — посмотреть, что нового`}
          onClick={() => ui.set({ updateOpen: true })}
        >
          <PixelIcon name="download" />
          <span className="zy-activity-dot" aria-hidden />
        </button>
      )}
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
