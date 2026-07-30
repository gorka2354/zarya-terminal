import { PANE_DRAG_CWD } from '@shared/types'
import { useState } from 'react'
import { closeTabAsking } from '@/actions/panes'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu, type MenuItem } from './ContextMenu'
import { Icon, ShellGlyph } from './Icon'
import { getThemes } from '@/features/themes/themes'
import logoZarya from '@/assets/logo-zarya-48.png'

/** Хвост пути: в шапке нужен проект, а не весь путь до него. */
function shortTail(p: string): string {
  // Windows-пути с обратными слэшами тоже: в шапке нужен проект, а не диск.
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}

/** Открыть папку новой вкладкой — тот же жест, что в сайдбаре. */
async function openFolder(): Promise<void> {
  const dir = await window.zarya.app.pickDirectory()
  if (dir) await useSessionsStore.getState().newTab(undefined, dir)
}

/** Добавить папку в проекты. */
async function addProject(): Promise<void> {
  const dir = await window.zarya.app.pickDirectory()
  const cur = useSettingsStore.getState().settings.bookmarks
  if (dir && !cur.includes(dir)) await useSettingsStore.getState().update({ bookmarks: [...cur, dir] })
}

export function Titlebar(): React.JSX.Element {
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const sessions = useSessionsStore((s) => s.sessions)
  const profiles = useSettingsStore((s) => s.profiles)
  const maximized = useUiStore((s) => s.maximized)
  const { menu, open } = useContextMenu()
  const bookmarks = useSettingsStore((s) => s.settings.bookmarks)
  // Имя проекта активной вкладки — оно же подпись кнопки и заголовок окна.
  const activeCwd = (() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return tab ? (sessions[tab.activeSessionId]?.cwd ?? '') : ''
  })()
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
          // По очереди и через вопрос: закрывать десяток терминалов пачкой,
          // не спросив ни про один недописанный запрос, — потеря без следа.
          void (async () => {
            for (const t of tabs.filter((t) => t.id !== tabId)) await closeTabAsking(t.id)
          })()
        }
      },
      {
        label: 'Закрыть вкладку',
        hint: 'Ctrl+Shift+W',
        danger: true,
        onClick: () => void closeTabAsking(tabId)
      }
    ])
  }

  return (
    <header className="zy-titlebar" onMouseEnter={() => setHover(true)}>
      <div className="zy-logo" title="Заря · ОРБИТА-1 — космический CLI-агент">
        <img className="zy-logo-mark" src={logoZarya} width={24} height={24} alt="Заря" />
        <span className="zy-logo-text">ЗАРЯ</span>
        <span className="zy-logo-tag">// ОРБИТА-1</span>
      </div>

      {/* Проекты — пусковая площадка, а не список происходящего, поэтому они
          живут здесь, а не в сайдбаре. Там они отнимали место у живых
          терминалов: чем больше проектов, тем ниже уезжала работа. */}
      <button
        className="zy-titlebar-proj"
        title={activeCwd || 'Проекты и недавние папки'}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const store2 = useSessionsStore.getState()
          const items: MenuItem[] = [
            { label: 'Открыть папку…', hint: 'Ctrl+Shift+O', onClick: () => void openFolder() }
          ]
          if (bookmarks.length) {
            items.push({ separator: true }, { label: 'ПРОЕКТЫ', disabled: true })
            for (const b of bookmarks) {
              items.push({
                label: shortTail(b),
                // Проект можно утащить прямо отсюда на нужную панель — так он
                // окажется ИМЕННО ТАМ, куда показали мышью, а не рядом с
                // активной. Пока проекты жили в сайдбаре, их таскали оттуда.
                hint: 'тащи на панель',
                drag: { type: PANE_DRAG_CWD, data: b },
                onClick: () => void store2.newTab(undefined, b)
              })
              items.push({
                label: '      ↳ панелью рядом',
                onClick: () => void store2.splitActive('row', b)
              })
            }
          }
          items.push(
            { separator: true },
            { label: 'Добавить папку в проекты…', onClick: () => void addProject() }
          )
          open(r.left, r.bottom + 4, items, e.currentTarget as HTMLElement)
        }}
      >
        <Icon name="folder" size={12} />
        {activeCwd ? shortTail(activeCwd) : 'проекты'}
        <Icon name="chevron-down" size={10} />
      </button>
      <div className="zy-titlebar-spacer" />

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
