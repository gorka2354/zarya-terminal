import { useMemo, useState } from 'react'
import type { SessionMeta } from '@shared/types'
import { formatRelative, shortenPath } from '@/lib/ansi'
import { fuzzyFilter } from '@/lib/fuzzy'
import { useAiStore } from '@/features/ai/aiStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu } from './ContextMenu'
import { Icon, ShellGlyph } from './Icon'

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
  const conversations = useAiStore((s) => s.conversations)
  const [query, setQuery] = useState('')
  const { menu, open } = useContextMenu()
  const store = useSessionsStore.getState()

  const crewActive = conversations.filter((c) => c.streaming || c.pendingTools.length > 0)

  const filtered = useMemo(
    () =>
      fuzzyFilter(query, savedList, (m) => `${m.title} ${m.cwd} ${m.lastCommand ?? ''}`, 200),
    [query, savedList]
  )

  const pinned = filtered.filter((m) => m.pinned)
  const favorites = filtered.filter((m) => m.favorite && !m.pinned)
  const recent = filtered.filter((m) => !m.pinned && !m.favorite)

  const openContext = (e: React.MouseEvent, m: SessionMeta): void => {
    e.preventDefault()
    open(e.clientX, e.clientY, [
      { label: 'Открыть', onClick: () => void store.restoreSaved(m.id) },
      {
        label: m.pinned ? 'Открепить' : 'Закрепить',
        onClick: () => void store.toggleFlag(m.id, 'pinned')
      },
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
            title={m.pinned ? 'Открепить' : 'Закрепить'}
            onClick={(e) => {
              e.stopPropagation()
              void store.toggleFlag(m.id, 'pinned')
            }}
          >
            <span className={`zy-item-flag${m.pinned ? ' zy-item-flag--on' : ''}`}>
              <Icon name="pin" size={13} />
            </span>
          </button>
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
        {pinned.length > 0 && (
          <>
            <div className="zy-section-label" style={sectionLabelStyle}>
              <Icon name="pin" size={11} />
              Закреплённые
            </div>
            {pinned.map(renderItem)}
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
        {!filtered.length && (
          <div className="zy-empty">
            Здесь появятся сохранённые сессии.
            <br />
            Они переживают перезапуск и выключение — просто продолжай с того места, где
            остановился.
            <br />
            <br />
            Новую сессию открывай вкладкой <b>+</b> сверху (Ctrl+Shift+T).
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
