import { useMemo, useState } from 'react'
import type { SessionMeta, TabState } from '@shared/types'
import { formatRelative, shortenPath } from '@/lib/ansi'
import { fuzzyFilter } from '@/lib/fuzzy'
import { useAiStore } from '@/features/ai/aiStore'
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
  const conversations = useAiStore((s) => s.conversations)
  const bookmarks = useSettingsStore((s) => s.settings.bookmarks)
  const [query, setQuery] = useState('')
  const { menu, open } = useContextMenu()
  const store = useSessionsStore.getState()

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
      { label: 'Новый терминал', hint: 'Ctrl+Shift+T', onClick: () => void store.newTab() },
      { label: 'Открыть папку…', hint: 'Ctrl+Shift+O', onClick: () => void openFolderAsTerminal() }
    ]
    if (bookmarks.length) {
      items.push({ separator: true }, { label: 'ПРОЕКТЫ', disabled: true })
      for (const b of bookmarks) {
        items.push({ label: shortenPath(b, 40), onClick: () => void store.newTab(undefined, b) })
      }
    }
    items.push(
      { separator: true },
      { label: 'Добавить папку в проекты…', onClick: () => void addProject() }
    )
    if (recentFolders.length) {
      items.push({ separator: true }, { label: 'НЕДАВНИЕ ПАПКИ', disabled: true })
      for (const f of recentFolders) {
        items.push({ label: shortenPath(f, 40), onClick: () => void store.newTab(undefined, f) })
      }
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    open(r.left, r.bottom + 4, items)
  }

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
  const shownTabs = q
    ? tabs.filter((t) => {
        const s = sessions[t.activeSessionId]
        return `${s?.title ?? ''} ${s?.cwd ?? ''}`.toLowerCase().includes(q)
      })
    : tabs
  const shownProjects = q ? bookmarks.filter((b) => b.toLowerCase().includes(q)) : bookmarks

  const openContext = (e: React.MouseEvent, m: SessionMeta): void => {
    e.preventDefault()
    open(e.clientX, e.clientY, [
      { label: 'Открыть', onClick: () => void store.restoreSaved(m.id) },
      {
        label: m.favorite ? 'Убрать из избранного' : 'В избранное',
        onClick: () => void store.toggleFlag(m.id, 'favorite')
      },
      {
        label: 'Переименовать…',
        onClick: () => {
          const title = window.prompt('Название сессии', m.title)
          if (title) void store.renameSession(m.id, title)
        }
      },
      { separator: true },
      {
        label: 'Удалить сессию',
        danger: true,
        disabled: !!sessions[m.id],
        onClick: () => {
          if (window.confirm(`Удалить сохранённую сессию «${m.title}»?`)) {
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
        title={`${m.cwd}\n${m.blocksCount} блоков · ${formatRelative(m.updatedAt)}`}
      >
        <span className="zy-item-icon">
          <ShellGlyph code={m.shellIcon || '>_'} />
        </span>
        <div className="zy-item-body">
          <div className="zy-item-title">
            {m.title}
            {isOpen && <span className="zy-badge zy-badge--ok" style={{ marginLeft: 6 }}>открыта</span>}
          </div>
          <div className="zy-item-sub zy-item-sub--path">
            {m.lastCommand ? `❯ ${m.lastCommand}` : shortenPath(m.cwd, 34)} ·{' '}
            {formatRelative(m.updatedAt)}
          </div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={m.favorite ? 'Убрать из избранного' : 'В избранное'}
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
        title={`Открыть терминал в ${dir}`}
        onClick={() => void store.newTab(undefined, dir)}
        onContextMenu={(e) => {
          e.preventDefault()
          open(e.clientX, e.clientY, [
            { label: 'Открыть терминал здесь', onClick: () => void store.newTab(undefined, dir) },
            { label: 'Открыть в проводнике', onClick: () => window.zarya.app.showItemInFolder(dir) },
            { separator: true },
            {
              label: 'Убрать из проектов',
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
            title="Убрать из проектов"
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
        label: 'Переименовать…',
        onClick: () => {
          const title = window.prompt('Название сессии', s.title)
          if (title) void store.renameSession(sid, title)
        }
      },
      {
        label: s.favorite ? 'Убрать из избранного' : 'В избранное',
        onClick: () => void store.toggleFlag(sid, 'favorite')
      },
      {
        label: s.pinned ? 'Открепить' : 'Закрепить (защита от очистки)',
        onClick: () => void store.toggleFlag(sid, 'pinned')
      },
      { separator: true },
      { label: 'Разделить вправо', onClick: () => void store.splitActive('row') },
      { label: 'Закрыть терминал', danger: true, onClick: () => void store.closeTab(tab.id) }
    ])
  }

  const renderOpenTab = (tab: TabState): React.JSX.Element => {
    const session = sessions[tab.activeSessionId]
    const count = listLeaves(tab.layout).length
    return (
      <div
        key={tab.id}
        className={`zy-item${tab.id === activeTabId ? ' zy-item--active' : ''}`}
        onClick={() => store.setActiveTab(tab.id)}
        onContextMenu={(e) => openTabContext(e, tab)}
        title={session?.cwd}
      >
        <span className="zy-item-icon">
          <ShellGlyph code={session?.shellIcon || '>_'} />
        </span>
        <div className="zy-item-body">
          <div className="zy-item-title">
            {session?.pinned && (
              <span
                title="Закреплена"
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  marginRight: 5,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  verticalAlign: 'middle'
                }}
              />
            )}
            {(session?.title || 'Терминал') + (count > 1 ? ` · ${count}` : '')}
          </div>
          <div className="zy-item-sub zy-item-sub--path">{shortenPath(session?.cwd || '', 34)}</div>
        </div>
        <div className="zy-item-actions">
          <button
            className="zy-icon-btn"
            title={session?.favorite ? 'Убрать из избранного' : 'В избранное'}
            onClick={(e) => {
              e.stopPropagation()
              void store.toggleFlag(tab.activeSessionId, 'favorite')
            }}
          >
            <Icon name={session?.favorite ? 'star' : 'star-outline'} size={13} />
          </button>
          <button
            className="zy-icon-btn"
            title="Закрыть терминал"
            onClick={(e) => {
              e.stopPropagation()
              void store.closeTab(tab.id)
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
          Сессии
          <span style={enSubStyle}>SESSIONS</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <button
            className="zy-icon-btn"
            title="Новый терминал (Ctrl+Shift+T)"
            onClick={() => void store.newTab()}
            onContextMenu={openNewMenu}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            className="zy-icon-btn"
            title="Открыть в папке / проект / недавние…"
            onClick={openNewMenu}
          >
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
      </div>
      <div className="zy-sidebar-search">
        <input
          className="zy-input"
          placeholder="Поиск сессий…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="zy-sidebar-body">
        {shownTabs.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="terminal" size={11} />
              Открытые
            </div>
            {shownTabs.map(renderOpenTab)}
          </>
        )}
        {shownProjects.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="folder" size={11} />
              Проекты
            </div>
            {shownProjects.map(renderProject)}
          </>
        )}
        {favorites.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="star" size={11} />
              Избранные
            </div>
            {favorites.map(renderItem)}
          </>
        )}
        {recent.length > 0 && (
          <>
            <div className="zy-section-label">Недавние</div>
            {recent.map(renderItem)}
          </>
        )}
        {!tabs.length && !favorites.length && !recent.length && (
          <div className="zy-empty">
            Открой новый терминал кнопкой <b>+</b> в заголовке (Ctrl+Shift+T).
            <br />
            <br />
            Сессии переживают перезапуск и выключение — закрытые появятся здесь для
            восстановления.
          </div>
        )}
        <div className="zy-section-label" style={crewLabelStyle}>
          Экипаж · агенты
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
                  выполняется
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
            <div className="zy-item-title">Борт-инженер / готов</div>
          </div>
        )}
      </div>
      {menu}
    </>
  )
}
