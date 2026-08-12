import { PANE_DRAG_CWD } from '@shared/types'
import { samePath } from '@shared/projects'
import { useState } from 'react'
import { closeTabAsking } from '@/actions/panes'
import { forgetProject, openFolderAsTab, openProject, openProjectBeside } from '@/actions/projects'
import { t, useLang } from '@/lib/i18n'
import { askText } from '@/components/AskText'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { getThemes } from '@/features/themes/themes'
import logoZarya from '@/assets/logo-zarya-48.png'

/** Хвост пути: в шапке нужен проект, а не весь путь до него. */
function shortTail(p: string): string {
  // Windows-пути с обратными слэшами тоже: в шапке нужен проект, а не диск.
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
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

  /*
   * Вкладок в шапке нет намеренно.
   *
   * Рабочие столы живут в сайдбаре, где видно и их панели. Здесь до сегодня
   * лежали ещё tabTitle / openNewTabMenu / openTabContext — остатки прежней
   * раскладки, которые никто не вызывал: мёртвый код читается как «функция
   * есть, просто спрятана», и следующий разработчик тратит время, выясняя,
   * почему она не работает. Навигация по столам при скрытом сайдбаре — через
   * палитру (действия «Стол: …») и Ctrl+Tab.
   */
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
          const items: MenuItem[] = [
            // Выбранная папка и открывается, и попадает в список ниже. Отдельный
            // пункт «добавить папку в проекты» открывал ТО ЖЕ окно выбора и
            // отличался лишь тем, что папку не открывал, — снаружи это читалось
            // как один пункт, продублированный дважды.
            {
              label: t('projects.openFolder'),
              hint: 'Ctrl+Shift+O',
              onClick: () => void openFolderAsTab()
            }
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
            const openCwds = Object.values(sessions).map((x) => x.cwd)
            for (const b of bookmarks) {
              const openNow = openCwds.some((c) => samePath(c, b))
              items.push({
                label: `${openNow ? '● ' : ''}${shortTail(b)}`,
                // Проект можно утащить прямо отсюда на нужную панель — так он
                // окажется ИМЕННО ТАМ, куда показали мышью, а не рядом с
                // активной. Пока проекты жили в сайдбаре, их таскали оттуда.
                drag: { type: PANE_DRAG_CWD, data: b },
                onClick: () => void openProject(b),
                actions: [
                  {
                    title: t('projects.openBeside', { path: b }),
                    node: <Icon name="split-h" size={13} />,
                    onClick: () => void openProjectBeside(b)
                  },
                  {
                    title: t('projects.remove', { name: shortTail(b) }),
                    node: <Icon name="close" size={12} />,
                    danger: true,
                    onClick: () => void forgetProject(b)
                  }
                ]
              })
            }
          }
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
