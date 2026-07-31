import { useUiStore, type SidebarView } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { toggleIdeMode } from '@/features/ide/ideMode'
import { hasUpdate, useUpdateStore } from '@/features/updates/updateStore'
import { PixelIcon, type PixelIconName } from './PixelIcon'
import { t, useLang } from '@/lib/i18n'

type Item = { view: Exclude<SidebarView, null>; icon: PixelIconName; titleKey: string }
// Base views are always present; IDE views only when the IDE layer is enabled.
const BASE_ITEMS: Item[] = [
  { view: 'sessions', icon: 'sessions', titleKey: 'sidebar.sessions' },
  { view: 'history', icon: 'history', titleKey: 'activity.history' }
]
const IDE_ITEMS: Item[] = [
  { view: 'files', icon: 'files', titleKey: 'activity.files' },
  { view: 'workflows', icon: 'workflows', titleKey: 'activity.workflows' }
]

export function ActivityBar(): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const sidebarView = useUiStore((s) => s.sidebarView)
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen)
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  const upd = useUpdateStore((s) => s.state)
  const ui = useUiStore.getState()

  const btn = (item: Item): React.JSX.Element => (
    <button
      key={item.view}
      className={`zy-activity-btn${sidebarView === item.view ? ' zy-activity-btn--active' : ''}`}
      title={t(item.titleKey)}
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
          title={t('activity.ideAgent')}
          onClick={() => ui.set({ aiPanelOpen: !aiPanelOpen })}
        >
          <PixelIcon name="sputnik" />
        </button>
      )}
      <button
        className={`zy-activity-btn zy-activity-ide${ideMode ? ' zy-activity-ide--on' : ''}`}
        title={t(ideMode ? 'activity.ideOn' : 'activity.ideOff')}
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
          title={t('activity.updateReady', { version: upd?.latest?.version ?? '' })}
          onClick={() => ui.set({ updateOpen: true })}
        >
          <PixelIcon name="download" />
          <span className="zy-activity-dot" aria-hidden />
        </button>
      )}
      <button
        className="zy-activity-btn"
        title={t('activity.settings')}
        onClick={() => ui.set({ settingsOpen: true })}
      >
        <PixelIcon name="gear" />
      </button>
    </nav>
  )
}
