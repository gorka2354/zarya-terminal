import { useState } from 'react'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu } from './ContextMenu'
import { Icon, ShellGlyph } from './Icon'
import { getThemes } from '@/features/themes/themes'
import logoRocket from '@/assets/logo-rocket-48.png'

export function Titlebar(): React.JSX.Element {
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const sessions = useSessionsStore((s) => s.sessions)
  const profiles = useSettingsStore((s) => s.profiles)
  const maximized = useUiStore((s) => s.maximized)
  const { menu, open } = useContextMenu()
  const [, setHover] = useState(false)

  const store = useSessionsStore.getState()

  const tabTitle = (tabId: string): { icon: string; title: string; pinned: boolean } => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return { icon: '>_', title: '—', pinned: false }
    const session = sessions[tab.activeSessionId]
    const count = listLeaves(tab.layout).length
    return {
      icon: session?.shellIcon || '>_',
      title: (session?.title || 'Терминал') + (count > 1 ? ` · ${count}` : ''),
      pinned: session?.pinned ?? false
    }
  }

  const openNewTabMenu = (x: number, y: number): void => {
    open(
      x,
      y,
      profiles.map((p) => ({
        label: `${p.icon}  ${p.name}`,
        onClick: () => void store.newTab(p.id)
      }))
    )
  }

  const openTabContext = (x: number, y: number, tabId: string): void => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const sid = tab.activeSessionId
    open(x, y, [
      {
        label: 'Переименовать…',
        onClick: () => {
          const cur = sessions[sid]
          const title = window.prompt('Название сессии', cur?.title ?? '')
          if (title) void store.renameSession(sid, title)
        }
      },
      {
        label: sessions[sid]?.pinned ? 'Открепить' : 'Закрепить',
        onClick: () => void store.toggleFlag(sid, 'pinned')
      },
      {
        label: sessions[sid]?.favorite ? 'Убрать из избранного' : 'В избранное',
        onClick: () => void store.toggleFlag(sid, 'favorite')
      },
      { separator: true },
      {
        label: 'Закрыть другие вкладки',
        onClick: () => {
          for (const t of tabs.filter((t) => t.id !== tabId)) void store.closeTab(t.id)
        }
      },
      {
        label: 'Закрыть вкладку',
        hint: 'Ctrl+Shift+W',
        danger: true,
        onClick: () => void store.closeTab(tabId)
      }
    ])
  }

  return (
    <header className="zy-titlebar" onMouseEnter={() => setHover(true)}>
      <div className="zy-logo" title="Заря · ОРБИТА-1 — космический CLI-агент">
        <img className="zy-logo-mark" src={logoRocket} width={24} height={24} alt="Заря" />
        <span className="zy-logo-text">ЗАРЯ</span>
        <span className="zy-logo-tag">// ОРБИТА-1</span>
      </div>

      <div className="zy-tabs">
        {tabs.map((tab) => {
          const { icon, title, pinned } = tabTitle(tab.id)
          return (
            <div
              key={tab.id}
              className={`zy-tab${tab.id === activeTabId ? ' zy-tab--active' : ''}`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  void store.closeTab(tab.id)
                } else if (e.button === 0) {
                  store.setActiveTab(tab.id)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openTabContext(e.clientX, e.clientY, tab.id)
              }}
            >
              {pinned && (
                <span className="zy-tab-pin">
                  <Icon name="pin" size={11} />
                </span>
              )}
              <span className="zy-tab-icon">
                <ShellGlyph code={icon} />
              </span>
              <span className="zy-tab-title">{title}</span>
              <button
                className="zy-tab-close"
                title="Закрыть"
                onClick={(e) => {
                  e.stopPropagation()
                  void store.closeTab(tab.id)
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )
        })}
        <button
          className="zy-icon-btn zy-newtab"
          title="Новая вкладка (Ctrl+Shift+T) · ПКМ — выбор шелла"
          onClick={() => void store.newTab()}
          onContextMenu={(e) => {
            e.preventDefault()
            openNewTabMenu(e.clientX, e.clientY)
          }}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>

      <button
        className="zy-theme-btn"
        title="Сменить тему борта"
        onClick={() => {
          const themes = getThemes()
          const cur = useSettingsStore.getState().settings.appearance.themeId
          const i = themes.findIndex((t) => t.id === cur)
          const next = themes[(i + 1) % themes.length]
          void useSettingsStore.getState().update({ appearance: { themeId: next.id } as never })
        }}
      >
        <Icon name="orbit" size={13} strokeWidth={1.5} />
        ТЕМА
      </button>

      <div className="zy-win-controls">
        <button
          className="zy-win-btn"
          title="Свернуть"
          onClick={() => window.zarya.app.windowCommand('minimize')}
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          className="zy-win-btn"
          title={maximized ? 'Восстановить' : 'Развернуть'}
          onClick={() => window.zarya.app.windowCommand('maximize')}
        >
          <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
        </button>
        <button
          className="zy-win-btn zy-win-btn--close"
          title="Закрыть"
          onClick={() => window.zarya.app.windowCommand('close')}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {menu}
    </header>
  )
}
