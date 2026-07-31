import { PANE_DRAG_CWD, PANE_DRAG_SESSION } from '@shared/types'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta, TabState } from '@shared/types'
import { closePaneAsking, closeTabAsking, setPaneMaximized } from '@/actions/panes'
import { deskTitle } from '@shared/deskTitle'
import { t } from '@/lib/i18n'
import { formatRelative, shortenPath } from '@/lib/ansi'
import { fuzzyFilter } from '@/lib/fuzzy'
import { useAiStore } from '@/features/ai/aiStore'
import { focusPane } from '@/terminal/paneFocus'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu, type MenuItem } from './ContextMenu'
import { Icon, ShellGlyph } from './Icon'

/** Open a native folder picker and start a new terminal there. */
export async function openFolderAsTerminal(): Promise<void> {
  const dir = await window.zarya.app.pickDirectory()
  if (dir) await useSessionsStore.getState().newTab(undefined, dir)
}

const sectionLabelStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const enSubStyle: React.CSSProperties = {
  fontFamily: 'var(--font-tech)',
  fontSize: 12,
  fontWeight: 400,
  color: 'var(--fg-faint)',
  letterSpacing: '.1em',
  marginLeft: 8
}
const crewLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-tech)',
  fontSize: 12,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)'
}
const crewStatusStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--fg-faint)'
}

function openCrewMember(conversationId: string): void {
  useUiStore.getState().set({ aiPanelOpen: true })
  useAiStore.getState().setActiveConversation(conversationId)
}

/**
 * Saved sessions panel: pinned / favorites / recent.
 * Sessions survive app restarts and device shutdowns — restoring re-opens
 * scrollback + blocks and starts a fresh shell in the saved cwd.
 */
export function SessionsPanel(): React.JSX.Element {
  const savedList = useSessionsStore((s) => s.savedList)
  const sessions = useSessionsStore((s) => s.sessions)
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const maximizedByTab = useUiStore((s) => s.maximizedByTab)
  const conversations = useAiStore((s) => s.conversations)
  const bookmarks = useSettingsStore((s) => s.settings.bookmarks)
  const [query, setQuery] = useState('')
  const { menu, open } = useContextMenu()
  const store = useSessionsStore.getState()
  /** Что было развёрнуто до начала жеста мышью (см. строку панели). */
  const maxBeforeClick = useRef<string | null>(null)
  /** Строка (вкладки или панели), над которой сейчас держат перетаскиваемую панель. */
  const [dropTab, setDropTab] = useState<string | null>(null)
  /** Панель тащат над пустотой списка — тоже «вынести», но без своего приёмника. */
  const [dropDetach, setDropDetach] = useState(false)
  /** Курсор над самим приёмником. Отдельно от пустоты: подсвечивать оба разом —
   *  значит показать две цели там, где цель одна. */
  const [zoneOver, setZoneOver] = useState(false)
  /**
   * Панель, которую тащат прямо сейчас (по всему окну, не только по сайдбару).
   *
   * Нужна, чтобы ПОКАЗАТЬ приёмник заранее. Пока подсветка появлялась только под
   * курсором, зону надо было сначала угадать: человек тащил панель и не знал,
   * куда её нести. Теперь приёмник виден с первого же движения.
   */
  const [dragPane, setDragPane] = useState<string | null>(null)

  // Начало и конец перетаскивания панели ловим на окне: хватают её далеко от
  // сайдбара — за шапку самой панели, — а показать приёмник надо здесь и сразу.
  useEffect(() => {
    const onStart = (e: DragEvent): void => {
      const types = e.dataTransfer?.types
      if (!types?.includes(PANE_DRAG_SESSION)) return
      setDragPane(e.dataTransfer?.getData(PANE_DRAG_SESSION) || '')
    }
    const onEnd = (): void => {
      setDragPane(null)
      setDropDetach(false)
      setZoneOver(false)
      setDropTab(null)
    }
    window.addEventListener('dragstart', onStart)
    window.addEventListener('dragend', onEnd)
    window.addEventListener('drop', onEnd)
    // Страховка: жест мог закончиться и без dragend (отпустили кнопку там, где
    // браузер его не шлёт). Подсказка, повисшая насовсем, врёт о происходящем.
    window.addEventListener('mouseup', onEnd)
    return () => {
      window.removeEventListener('dragstart', onStart)
      window.removeEventListener('dragend', onEnd)
      window.removeEventListener('drop', onEnd)
      window.removeEventListener('mouseup', onEnd)
    }
  }, [])

  // Recent folders: distinct cwds from saved sessions, minus already-bookmarked.
  const recentFolders = useMemo(() => {
    const seen = new Set(bookmarks)
    const out: string[] = []
    for (const m of savedList) {
      if (m.cwd && !seen.has(m.cwd)) {
        seen.add(m.cwd)
        out.push(m.cwd)
      }
      if (out.length >= 6) break
    }
    return out
  }, [savedList, bookmarks])

  const addProject = async (): Promise<void> => {
    const dir = await window.zarya.app.pickDirectory()
    if (dir && !bookmarks.includes(dir)) {
      await useSettingsStore.getState().update({ bookmarks: [...bookmarks, dir] })
    }
  }

  // Dropdown on the header ▾: quick-new + open-in-folder + projects + recents.
  const openNewMenu = (e: React.MouseEvent): void => {
    const items: MenuItem[] = [
      { label: t('projects.newTerminal'), hint: 'Ctrl+Shift+T', onClick: () => void store.newTab() },
      { label: t('projects.openFolder'), hint: 'Ctrl+Shift+O', onClick: () => void openFolderAsTerminal() },
      {
        label: t('projects.newPaneIn'),
        onClick: () => {
          void window.zarya.app.pickDirectory().then((dir) => {
            if (dir) void store.splitActive('row', dir)
          })
        }
      }
    ]
    if (bookmarks.length) {
      items.push({ separator: true }, { label: t('projects.section'), disabled: true })
      for (const b of bookmarks) {
        // Подменю наше меню не умеет, поэтому «панелью рядом» живёт в
        // контекстном меню проекта и в пункте «Новая панель в папке…» выше.
        items.push({ label: shortenPath(b, 40), onClick: () => void store.newTab(undefined, b) })
      }
    }
    items.push(
      { separator: true },
      { label: t('projects.add'), onClick: () => void addProject() }
    )
    if (recentFolders.length) {
      items.push({ separator: true }, { label: t('projects.recentFolders'), disabled: true })
      for (const f of recentFolders) {
        items.push({ label: shortenPath(f, 40), onClick: () => void store.newTab(undefined, f) })
      }
    }
    const btn = e.currentTarget as HTMLElement
    const r = btn.getBoundingClientRect()
    // Якорь: без него повторное нажатие по той же кнопке закрывало меню по
    // mousedown и тут же открывало по click.
    open(r.left, r.bottom + 4, items, btn)
  }

  /**
   * Приёмник «вернуть панель в список».
   *
   * Появляется на время жеста и прямо говорит, что произойдёт: панель уедет из
   * сетки в свой рабочий стол, процесс при этом не тронется. Показываем только
   * когда выносить есть что: у панели-одиночки своей вкладки нет соседей, и
   * зона предлагала бы жест, который ничего не делает.
   */
  const dragHome = dragPane ? tabs.find((t) => listLeaves(t.layout).includes(dragPane)) : undefined
  const canDetach = !!dragHome && listLeaves(dragHome.layout).length > 1
  const dropZone = canDetach ? (
    <div
      className={`zy-drop-zone${zoneOver ? ' zy-drop-zone--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setZoneOver(true)
        setDropDetach(false)
      }}
      onDragLeave={() => setZoneOver(false)}
      onDrop={(e) => {
        const moved = e.dataTransfer.getData(PANE_DRAG_SESSION) || dragPane
        e.preventDefault()
        e.stopPropagation()
        setZoneOver(false)
        setDragPane(null)
        if (moved) store.detachPane(moved)
      }}
    >
      <div className="zy-drop-zone-title">{t('pane.dropZoneTitle')}</div>
      <div className="zy-drop-zone-sub">
        {t('pane.dropZoneSub')}
      </div>
    </div>
  ) : null

  const crewActive = conversations.filter((c) => c.streaming || c.pendingTools.length > 0)

  // Session ids currently open in a tab — excluded from the saved list so an
  // open terminal shows once (in ОТКРЫТЫЕ), never duplicated below.
  const openIds = useMemo(() => new Set(tabs.flatMap((t) => listLeaves(t.layout))), [tabs])

  const filtered = useMemo(
    () =>
      fuzzyFilter(query, savedList, (m) => `${m.title} ${m.cwd} ${m.lastCommand ?? ''}`, 200),
    [query, savedList]
  )

  const savedClosed = filtered.filter((m) => !openIds.has(m.id))
  const favorites = savedClosed.filter((m) => m.favorite)
  const recent = savedClosed.filter((m) => !m.favorite)

  // The search box filters ALL sections, not just saved sessions.
  const q = query.trim().toLowerCase()
  /** Подходит ли ПАНЕЛЬ под поиск — по названию и папке своей сессии. */
  const paneMatches = (sessionId: string): boolean => {
    const s = sessions[sessionId]
    return `${s?.title ?? ''} ${s?.cwd ?? ''}`.toLowerCase().includes(q)
  }
  // Вкладка остаётся в списке, если под поиск подходит ЛЮБАЯ её панель: искать
  // по одной активной значило бы прятать вкладку, в которой искомое открыто.
  const shownTabs = q ? tabs.filter((t) => listLeaves(t.layout).some(paneMatches)) : tabs
  const shownProjects = q ? bookmarks.filter((b) => b.toLowerCase().includes(q)) : bookmarks

  const openContext = (e: React.MouseEvent, m: SessionMeta): void => {
    e.preventDefault()
    open(e.clientX, e.clientY, [
      { label: t('common.open'), onClick: () => void store.restoreSaved(m.id) },
      {
        label: t(m.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd'),
        onClick: () => void store.toggleFlag(m.id, 'favorite')
      },
      {
        label: t('common.rename'),
        onClick: () => {
          const title = window.prompt(t('common.sessionName'), m.title)
          if (title) void store.renameSession(m.id, title)
        }
      },
      { separator: true },
      {
        label: t('common.delete'),
        danger: true,
        disabled: !!sessions[m.id],
        onClick: () => {
          if (window.confirm(t('common.deleteAsk', { name: m.title }))) {
            void store.deleteSaved(m.id)
          }
        }
      }
    ])
  }

  const renderItem = (m: SessionMeta): React.JSX.Element => {
    const isOpen = !!sessions[m.id]
    return (
      <div
        key={m.id}
        className={`zy-item${isOpen ? ' zy-item--active' : ''}`}
        onClick={() => void store.restoreSaved(m.id)}
        onContextMenu={(e) => openContext(e, m)}
        title={`${m.cwd}\n${t('sidebar.blocks', { n: m.blocksCount })} · ${formatRelative(m.updatedAt)}`}
      >
        <span className="zy-item-icon">
          <ShellGlyph code={m.shellIcon || '>_'} />
        </span>
        <div className="zy-item-body">
          <div className="zy-item-title">
            {m.title}
            {isOpen && <span className="zy-badge zy-badge--ok" style={{ marginLeft: 6 }}>{t('sidebar.openBadge')}</span>}
          </div>
          <div className="zy-item-sub zy-item-sub--path">
            {m.lastCommand ? `❯ ${m.lastCommand}` : shortenPath(m.cwd, 34)} ·{' '}
            {formatRelative(m.updatedAt)}
          </div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={t(m.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd')}
            onClick={(e) => {
              e.stopPropagation()
              void store.toggleFlag(m.id, 'favorite')
            }}
          >
            <span className={`zy-item-flag${m.favorite ? ' zy-item-flag--on' : ''}`}>
              <Icon name={m.favorite ? 'star' : 'star-outline'} size={13} />
            </span>
          </button>
        </div>
      </div>
    )
  }

  const renderProject = (dir: string): React.JSX.Element => {
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir
    return (
      <div
        key={dir}
        className="zy-item"
        title={t('projects.openIn', { dir })}
        onClick={() => void store.newTab(undefined, dir)}
        // Схватить проект и бросить на рабочую область — получится панель рядом.
        // Внутри одного окна перетаскивание штатное: это тот же документ.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DRAG_CWD, dir)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          open(e.clientX, e.clientY, [
            { label: t('projects.openHere'), onClick: () => void store.newTab(undefined, dir) },
            { label: t('pane.openBeside'), onClick: () => void store.splitActive('row', dir) },
            { label: t('projects.showInExplorer'), onClick: () => window.zarya.app.showItemInFolder(dir) },
            { separator: true },
            {
              label: t('projects.removeShort'),
              danger: true,
              onClick: () =>
                void useSettingsStore
                  .getState()
                  .update({ bookmarks: bookmarks.filter((b) => b !== dir) })
            }
          ])
        }}
      >
        <span className="zy-item-icon" style={{ color: 'var(--accent)' }}>
          <Icon name="folder" size={15} />
        </span>
        <div className="zy-item-body">
          <div className="zy-item-title">{name}</div>
          <div className="zy-item-sub zy-item-sub--path">{shortenPath(dir, 34)}</div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={t('projects.removeShort')}
            onClick={(e) => {
              e.stopPropagation()
              void useSettingsStore
                .getState()
                .update({ bookmarks: bookmarks.filter((b) => b !== dir) })
            }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    )
  }

  const openTabContext = (e: React.MouseEvent, tab: TabState): void => {
    e.preventDefault()
    const sid = tab.activeSessionId
    const s = sessions[sid]
    if (!s) return
    open(e.clientX, e.clientY, [
      {
        label: t('common.rename'),
        onClick: () => {
          const title = window.prompt(t('common.sessionName'), s.title)
          if (title) void store.renameSession(sid, title)
        }
      },
      {
        label: t(s.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd'),
        onClick: () => void store.toggleFlag(sid, 'favorite')
      },
      {
        label: t(s.pinned ? 'common.unpin' : 'common.pin'),
        onClick: () => void store.toggleFlag(sid, 'pinned')
      },
      { separator: true },
      {
        label: t('pane.splitRight'),
        // Делим ТУ вкладку, по строке которой щёлкнули: раньше панель уезжала в
        // активную, а при её заполненности тост говорил про лимит вкладки,
        // которую человек даже не трогал.
        onClick: () => {
          store.setActiveTab(tab.id)
          void store.splitActive('row')
        }
      },
      { label: t('pane.closeTab'), danger: true, onClick: () => void closeTabAsking(tab.id) }
    ])
  }

  const openPaneContext = (e: React.MouseEvent, sessionId: string, tab: TabState): void => {
    e.preventDefault()
    const s = sessions[sessionId]
    if (!s) return
    const panes = listLeaves(tab.layout).length
    open(e.clientX, e.clientY, [
      {
        label:
          t(maximizedByTab[tab.id] === sessionId ? 'pane.restore' : 'pane.maximize'),
        hint: t('pane.dblclick'),
        onClick: () => setPaneMaximized(sessionId, maximizedByTab[tab.id] !== sessionId)
      },
      {
        label: t('common.rename'),
        onClick: () => {
          const title = window.prompt(t('common.sessionName'), s.title)
          if (title) void store.renameSession(sessionId, title)
        }
      },
      {
        label: t(s.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd'),
        onClick: () => void store.toggleFlag(sessionId, 'favorite')
      },
      { separator: true },
      {
        label: t('pane.openBeside'),
        // Делим ТУ панель, по которой щёлкнули: делить «активную» значило бы
        // открыть панель не там, куда показали мышью.
        onClick: () => {
          store.setActiveSession(sessionId)
          void store.splitActive('row')
        }
      },
      {
        // Убрать CLI с разделённого экрана, не убивая его: панель уезжает в свой
        // рабочий стол и остаётся в списке свёрнутой строкой.
        label: t('pane.detach'),
        hint: t('pane.detachHint'),
        disabled: panes < 2,
        onClick: () => store.detachPane(sessionId)
      },
      {
        label: t('desk.renameBtn'),
        onClick: () => renameDesk(tab)
      },
      { label: t('pane.close'), danger: true, onClick: () => void closePaneAsking(sessionId) },
      // Закрыть весь рабочий стол: у активной вкладки своей строки в списке нет
      // (она раскрыта панелями), и без этого пункта закрыть её целиком можно
      // было бы только горячей клавишей.
      ...(panes > 1
        ? [
            {
              label: `${t('pane.closeWhole')} · ${panes}`,
              danger: true,
              hint: 'Ctrl+Shift+W',
              onClick: () => void closeTabAsking(tab.id)
            }
          ]
        : [])
    ])
  }

  /**
   * Строка ПАНЕЛИ активной вкладки.
   *
   * Две степени выделения, и путать их нельзя. «На экране» (панель видна в
   * сетке) — сдержанная подсветка фона; таких строк бывает четыре. «В фокусе»
   * (панели достаются Enter и Esc) — тот же акцент, что у рамки панели на
   * экране; такая строка ровно одна. Если четыре строки получат вид активной
   * рамки, человек перестанет понимать, куда уйдёт одобрение запуска команды.
   */
  const renderPane = (sessionId: string, tab: TabState): React.JSX.Element => {
    const session = sessions[sessionId]
    const focused = tab.activeSessionId === sessionId
    // Разворот считается по СВОЕЙ вкладке: развёрнутая панель соседнего
    // рабочего стола об этих панелях ничего не говорит.
    const maxedHere = maximizedByTab[tab.id]
    const maxed = maxedHere === sessionId
    // «На экране» значит РОВНО это: панель сейчас видно. Развёрнут сосед — её не
    // видно, и подсветка обязана погаснуть, иначе список врёт о происходящем.
    const onScreen = !maxedHere || maxed
    return (
      <div
        key={sessionId}
        data-session={sessionId}
        className={`zy-item zy-pane-row${onScreen ? ' zy-item--onscreen' : ''}${focused ? ' zy-item--focus' : ''}${dropTab === sessionId ? ' zy-item--drop' : ''}`}
        title={
          focused
            ? `${session?.cwd ?? ''}\n${t('pane.focused')}`
            : onScreen
              ? `${session?.cwd ?? ''}\n${t('pane.clickToFocus')}`
              : `${session?.cwd ?? ''}\n${t('pane.hiddenByMax')}`
        }
        // Что было развёрнуто ДО жеста. Двойной клик — это click, click,
        // dblclick: первый клик уже переносит разворот на эту панель, и
        // «переключить» на третьем шаге свернул бы то, что просили развернуть.
        onMouseDown={(e) => {
          if (e.detail <= 1) maxBeforeClick.current = maxedHere ?? null
        }}
        // Клик делает панель активной, но НЕ переключает вкладку и не трогает
        // текст в строках ввода: набранное остаётся там, где его набирали.
        onClick={() => {
          // Развёрнут сосед — эту панель не видно; разворачивать её вместо него
          // будет сам стор: фокус и «что видно» обязаны сходиться всегда, а не
          // только при клике отсюда.
          store.setActiveSession(sessionId)
          // Курсор уезжает в строку ВЫБРАННОЙ панели: печатать после клика надо
          // где-то. Текст, набранный в других панелях, при этом не трогается —
          // он живёт в их собственных строках.
          focusPane(sessionId)
        }}
        onDoubleClick={() => setPaneMaximized(sessionId, maxBeforeClick.current !== sessionId)}
        onContextMenu={(e) => openPaneContext(e, sessionId, tab)}
        // Панель хватается за свою строку: бросок на другую панель переносит её
        // ТУДА. Процесс не трогается — двигается лист в дереве.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DRAG_SESSION, sessionId)
          e.dataTransfer.effectAllowed = 'move'
        }}
        // Бросок на строку панели ставит принесённую РЯДОМ с этой.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANE_DRAG_SESSION)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setDropTab(sessionId)
        }}
        onDragLeave={() => setDropTab(null)}
        onDrop={(e) => {
          const moved = e.dataTransfer.getData(PANE_DRAG_SESSION)
          if (!moved) return
          e.preventDefault()
          e.stopPropagation()
          setDropTab(null)
          store.movePaneNextTo(moved, sessionId)
        }}
      >
        <span className="zy-item-icon">
          <ShellGlyph code={session?.shellIcon || '>_'} />
        </span>
        <div className="zy-item-body">
          <div className="zy-item-title">
            {session?.pinned && <span className="zy-pin-dot" title={t('session.pinned')} />}
            {session?.title || t('desk.untitled')}
            {maxed && (
              <span className="zy-badge" style={{ marginLeft: 6 }}>
                {t('pane.maximized')}
              </span>
            )}
          </div>
          <div className="zy-item-sub zy-item-sub--path">{shortenPath(session?.cwd || '', 34)}</div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={t(session?.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd')}
            onClick={(e) => {
              e.stopPropagation()
              void store.toggleFlag(sessionId, 'favorite')
            }}
          >
            <Icon name={session?.favorite ? 'star' : 'star-outline'} size={13} />
          </button>
          <button
            className="zy-icon-btn"
            title={t('pane.close')}
            onClick={(e) => {
              e.stopPropagation()
              void closePaneAsking(sessionId)
            }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    )
  }

  /**
   * СВЁРНУТАЯ вкладка — одна строка со счётчиком панелей.
   *
   * Разворачивать все вкладки разом нельзя: три вкладки по четыре панели дают
   * двенадцать строк, и живое снова тонет. Развёрнута только активная.
   */
  const renderOpenTab = (tab: TabState): React.JSX.Element => {
    const session = sessions[tab.activeSessionId]
    const leaves = listLeaves(tab.layout)
    const count = leaves.length
    return (
      <div
        key={tab.id}
        data-tab={tab.id}
        className={`zy-item zy-tab-row${dropTab === tab.id ? ' zy-item--drop' : ''}`}
        onClick={() => store.setActiveTab(tab.id)}
        onDoubleClick={() => renameDesk(tab)}
        onContextMenu={(e) => openTabContext(e, tab)}
        title={`${session?.cwd ?? ''}\nКлик — открыть этот рабочий стол · 2×клик — переименовать\nБросьте сюда панель, чтобы перенести её в этот стол`}
        // Открытый терминал тоже хватается: бросок на панель переносит его
        // ТУДА. Процесс при этом не трогается — двигается лист в дереве.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DRAG_SESSION, tab.activeSessionId)
          e.dataTransfer.effectAllowed = 'move'
        }}
        // Строка вкладки — цель для броска: панель переезжает в ЭТОТ стол.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANE_DRAG_SESSION)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setDropTab(tab.id)
        }}
        onDragLeave={() => setDropTab(null)}
        onDrop={(e) => {
          const moved = e.dataTransfer.getData(PANE_DRAG_SESSION)
          if (!moved) return
          e.preventDefault()
          e.stopPropagation()
          setDropTab(null)
          store.movePaneNextTo(moved, tab.activeSessionId)
        }}
      >
        <span className="zy-item-icon">
          <ShellGlyph code={session?.shellIcon || '>_'} />
        </span>
        <div className="zy-item-body">
          <div className="zy-item-title">
            {session?.pinned && <span className="zy-pin-dot" title={t('session.pinned')} />}
            {deskTitle(
              leaves.map((sid) => sessions[sid]?.title ?? ''),
              tab.title
            ) + (count > 1 ? ` · ${count}` : '')}
          </div>
          <div className="zy-item-sub zy-item-sub--path">{shortenPath(session?.cwd || '', 34)}</div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={t(session?.favorite ? 'common.favoriteRemove' : 'common.favoriteAdd')}
            onClick={(e) => {
              e.stopPropagation()
              void store.toggleFlag(tab.activeSessionId, 'favorite')
            }}
          >
            <Icon name={session?.favorite ? 'star' : 'star-outline'} size={13} />
          </button>
          <button
            className="zy-icon-btn"
            title={t('pane.closeTab')}
            onClick={(e) => {
              e.stopPropagation()
              void closeTabAsking(tab.id)
            }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    )
  }

  /**
   * «Открытые»: панели активной вкладки — списком, остальные вкладки — свёрнутыми
   * строками, каждая на своём месте. Раньше здесь были только вкладки, и четыре
   * панели давали одну строку с припиской «· 4»: попасть мышью в конкретную
   * панель было нельзя.
   */
  const renderOpenRow = (tab: TabState): React.JSX.Element => {
    if (tab.id !== activeTabId) return renderOpenTab(tab)
    const all = listLeaves(tab.layout)
    const leaves = all.filter((sid) => !q || paneMatches(sid))
    // Фрагмент с ключом вкладки: строки панелей — это раскрытая вкладка, и
    // React должен видеть их одной группой, а не безымянным вложенным списком.
    return (
      <Fragment key={tab.id}>
        {renderDeskHead(tab, all)}
        {leaves.map((sid) => renderPane(sid, tab))}
      </Fragment>
    )
  }

  /** Спросить имя рабочего стола. Пустой ответ возвращает подпись «по панелям». */
  const renameDesk = (tab: TabState): void => {
    const now = deskTitle(
      listLeaves(tab.layout).map((sid) => sessions[sid]?.title ?? ''),
      tab.title
    )
    const next = window.prompt(t('desk.renamePrompt'), tab.title ?? now)
    if (next !== null) store.renameTab(tab.id, next)
  }

  /**
   * Заголовок РАЗВЁРНУТОГО (активного) рабочего стола.
   *
   * У активной вкладки своей строки в списке нет — её место занимают панели, — и
   * без заголовка получалось сразу две потери: имя стола негде показать и негде
   * переименовать, а закрыть его целиком можно было только горячей клавишей.
   * Одна строка на всю вкладку это чинит и заодно показывает, чьи это панели.
   */
  const renderDeskHead = (tab: TabState, leaves: string[]): React.JSX.Element => {
    const name = deskTitle(
      leaves.map((sid) => sessions[sid]?.title ?? ''),
      tab.title
    )
    return (
      <div
        key={`head:${tab.id}`}
        data-desk={tab.id}
        className="zy-item zy-desk-row"
        title={t('desk.rename')}
        onDoubleClick={() => renameDesk(tab)}
        onContextMenu={(e) => openTabContext(e, tab)}
      >
        <span className="zy-desk-caret">▾</span>
        <div className="zy-item-body">
          <div className="zy-item-title">
            {name}
            {leaves.length > 1 && <span className="zy-desk-count">· {leaves.length}</span>}
          </div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={t('desk.renameBtn')}
            onClick={(e) => {
              e.stopPropagation()
              renameDesk(tab)
            }}
          >
            <Icon name="edit" size={12} />
          </button>
          <button
            className="zy-icon-btn"
            title={t('desk.closeAll')}
            onClick={(e) => {
              e.stopPropagation()
              void closeTabAsking(tab.id)
            }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes zy-crew-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .35; }
        }
      `}</style>
      <div className="zy-sidebar-header">
        <span>
          {t('sidebar.sessions')}
          <span style={enSubStyle}>SESSIONS</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <button
            className="zy-icon-btn"
            title={t('sidebar.newTerminal')}
            onClick={() => void store.newTab()}
            onContextMenu={openNewMenu}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            className="zy-icon-btn"
            title={t('sidebar.moreMenu')}
            onClick={openNewMenu}
          >
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
      </div>
      <div className="zy-sidebar-search">
        <input
          className="zy-input"
          placeholder={t('sidebar.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* Пустое место списка — зона «вынести»: панель, брошенная мимо строк,
          уезжает в свой рабочий стол. Обратный жест к перетаскиванию панели на
          панель; без него убрать лишний CLI можно было только убив процесс. */}
      <div
        className={`zy-sidebar-body${dropDetach ? ' zy-sidebar-body--drop' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANE_DRAG_SESSION)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropDetach(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDetach(false)
        }}
        onDrop={(e) => {
          const moved = e.dataTransfer.getData(PANE_DRAG_SESSION)
          setDropDetach(false)
          if (!moved) return
          e.preventDefault()
          store.detachPane(moved)
        }}
      >
        {shownTabs.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="terminal" size={11} />
              {t('sidebar.open')}
            </div>
            {shownTabs.map(renderOpenRow)}
            {dropZone}
          </>
        )}
        {false && shownProjects.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="folder" size={11} />
              {t('projects.section')}
            </div>
            {shownProjects.map(renderProject)}
          </>
        )}
        {favorites.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="star" size={11} />
              {t('sidebar.favorites')}
            </div>
            {favorites.map(renderItem)}
          </>
        )}
        {recent.length > 0 && (
          <>
            <div className="zy-section-label">{t('sidebar.recent')}</div>
            {recent.map(renderItem)}
          </>
        )}
        {!tabs.length && !favorites.length && !recent.length && (
          <div className="zy-empty" style={{ whiteSpace: 'pre-line' }}>
            {t('sidebar.empty')}
          </div>
        )}
        <div className="zy-section-label" style={crewLabelStyle}>
          {t('sidebar.crew')}
        </div>
        {crewActive.length > 0 ? (
          crewActive.map((conv) => (
            <div key={conv.id} className="zy-item" onClick={() => openCrewMember(conv.id)}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: 'var(--success)',
                  boxShadow: '0 0 8px var(--success)',
                  animation: 'zy-crew-pulse 1.6s ease-in-out infinite'
                }}
              />
              <div className="zy-item-body">
                <div className="zy-item-title">{conv.title}</div>
                <div className="zy-item-sub" style={crewStatusStyle}>
                  {t('sidebar.crewBusy')}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="zy-item" style={{ cursor: 'default' }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                background: 'var(--fg-faint)'
              }}
            />
            <div className="zy-item-title">{t('sidebar.crewIdle')}</div>
          </div>
        )}
      </div>
      {menu}
    </>
  )
}
