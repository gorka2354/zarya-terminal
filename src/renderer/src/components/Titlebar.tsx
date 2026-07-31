import { PANE_DRAG_CWD } from '@shared/types'
import { useState } from 'react'
import { closeTabAsking } from '@/actions/panes'
import { t, useLang } from '@/lib/i18n'
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
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

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
      title: (session?.title || t('desk.untitled')) + (count > 1 ? ` · ${count}` : ''),
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
        label: t('common.rename'),
        onClick: () => {
          const cur = sessions[sid]
          const title = window.prompt(t('common.sessionName'), cur?.title ?? '')
          if (title) void store.renameSession(sid, title)
        }
      },
      {
        label: t(sessions[sid]?.pinned ? 'common.unpin' : 'common.pin'),
        onClick: () => void store.toggleFlag(sid, 'pinned')
      },
      {
        label: t(sessions[sid]?.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd'),
        onClick: () => void store.toggleFlag(sid, 'favorite')
      },
      { separator: true },
      {
        label: t('tab.closeOthers'),
        onClick: () => {
          // По очереди и через вопрос: закрывать десяток терминалов пачкой,
          // не спросив ни про один недописанный запрос, — потеря без следа.
          void (async () => {
            for (const t of tabs.filter((t) => t.id !== tabId)) await closeTabAsking(t.id)
          })()
        }
      },
      {
        label: t('tab.close'),
        hint: 'Ctrl+Shift+W',
        danger: true,
        onClick: () => void closeTabAsking(tabId)
      }
    ])
  }

  return (
    <header className="zy-titlebar" onMouseEnter={() => setHover(true)}>
      <div className="zy-logo" title={t('title.logoHint')}>
        {/* Имя бренда одно, начертание — по языку: кириллица в русском несёт
            характер, но в английском интерфейсе читается как шум. */}
        <img className="zy-logo-mark" src={logoZarya} width={24} height={24} alt="Zarya" />
        <span className="zy-logo-text">{t('brand')}</span>
        <span className="zy-logo-tag">{t('title.tagline')}</span>
      </div>

      {/* Проекты — пусковая площадка, а не список происходящего, поэтому они
          живут здесь, а не в сайдбаре. Там они отнимали место у живых
          терминалов: чем больше проектов, тем ниже уезжала работа. */}
      <button
        className="zy-titlebar-proj"
        title={`${activeCwd || t('title.noFolder')}
${t('title.projectsHint')}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const store2 = useSessionsStore.getState()
          const items: MenuItem[] = [
            { label: t('projects.openFolder'), hint: 'Ctrl+Shift+O', onClick: () => void openFolder() }
          ]
          if (bookmarks.length) {
            // Одна строка на проект. Раньше их было две: под каждым проектом
            // висел псевдо-подпункт «панелью рядом» — подменю наше меню не
            // умеет. Два проекта давали четыре строки, а отступ со стрелкой
            // схлопывался в мусор, и понять, что к чему относится, было нельзя.
            items.push(
              { separator: true },
              { label: t('projects.section'), hint: t('projects.clickHint'), disabled: true }
            )
            // Какие проекты уже открыты — видно точкой: список папок без этого
            // ничего не говорит о том, что происходит прямо сейчас.
            const openCwds = new Set(Object.values(sessions).map((x) => x.cwd))
            for (const b of bookmarks) {
              items.push({
                label: `${openCwds.has(b) ? '● ' : ''}${shortTail(b)}`,
                // Проект можно утащить прямо отсюда на нужную панель — так он
                // окажется ИМЕННО ТАМ, куда показали мышью, а не рядом с
                // активной. Пока проекты жили в сайдбаре, их таскали оттуда.
                drag: { type: PANE_DRAG_CWD, data: b },
                onClick: () => void store2.newTab(undefined, b),
                actions: [
                  {
                    title: t('projects.openBeside', { path: b }),
                    node: <Icon name="split-h" size={13} />,
                    onClick: () => void store2.splitActive('row', b)
                  },
                  {
                    title: t('projects.remove', { name: shortTail(b) }),
                    node: <Icon name="close" size={12} />,
                    danger: true,
                    onClick: () => {
                      const cur = useSettingsStore.getState().settings.bookmarks
                      void useSettingsStore
                        .getState()
                        .update({ bookmarks: cur.filter((x) => x !== b) })
                    }
                  }
                ]
              })
            }
          }
          items.push(
            { separator: true },
            { label: t('projects.add'), onClick: () => void addProject() }
          )
          open(r.left, r.bottom + 4, items, e.currentTarget as HTMLElement)
        }}
      >
        <Icon name="folder" size={12} />
        {activeCwd ? shortTail(activeCwd) : t('title.projects')}
        <Icon name="chevron-down" size={10} />
      </button>
      <div className="zy-titlebar-spacer" />

      <button
        className="zy-theme-btn"
        title={t('title.themeHint')}
        onClick={() => {
          const themes = getThemes()
          const cur = useSettingsStore.getState().settings.appearance.themeId
          const i = themes.findIndex((t) => t.id === cur)
          const next = themes[(i + 1) % themes.length]
          void useSettingsStore.getState().update({ appearance: { themeId: next.id } as never })
        }}
      >
        <Icon name="orbit" size={13} strokeWidth={1.5} />
        {t('title.theme')}
      </button>

      <div className="zy-win-controls">
        <button
          className="zy-win-btn"
          title={t('title.minimize')}
          onClick={() => window.zarya.app.windowCommand('minimize')}
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          className="zy-win-btn"
          title={t(maximized ? 'title.restore' : 'title.maximize')}
          onClick={() => window.zarya.app.windowCommand('maximize')}
        >
          <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
        </button>
        <button
          className="zy-win-btn zy-win-btn--close"
          title={t('title.close')}
          onClick={() => window.zarya.app.windowCommand('close')}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {menu}
    </header>
  )
}
