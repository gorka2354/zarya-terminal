import { useEffect, useRef, useState } from 'react'
import { XtermView } from '@/terminal/XtermView'
import { getTerminal } from '@/terminal/terminalRegistry'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu } from './ContextMenu'
import { Icon } from './Icon'

interface Props {
  sessionId: string
  active: boolean
  visible: boolean
}

export function TerminalPane({ sessionId, active, visible }: Props): React.JSX.Element {
  const store = useSessionsStore.getState()
  const searchOpenFor = useUiStore((s) => s.searchOpenFor)
  const rightClickBehavior = useSettingsStore((s) => s.settings.terminal.rightClickBehavior)
  const { menu, open } = useContextMenu()
  const multiPane = useSessionsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab ? tab.layout.type !== 'leaf' : false
  })

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const handle = getTerminal(sessionId)
    if (rightClickBehavior === 'paste') {
      void navigator.clipboard.readText().then((t) => t && handle?.term.paste(t))
      return
    }
    const hasSelection = !!handle?.term.getSelection()
    open(e.clientX, e.clientY, [
      {
        label: 'Копировать',
        hint: 'Ctrl+Shift+C',
        disabled: !hasSelection,
        onClick: () => {
          const sel = handle?.term.getSelection()
          if (sel) void navigator.clipboard.writeText(sel)
        }
      },
      {
        label: 'Вставить',
        hint: 'Ctrl+Shift+V',
        onClick: () => void navigator.clipboard.readText().then((t) => t && handle?.term.paste(t))
      },
      { separator: true },
      {
        label: 'Найти в терминале',
        hint: 'Ctrl+Shift+F',
        onClick: () => useUiStore.getState().set({ searchOpenFor: sessionId })
      },
      {
        label: 'Очистить',
        hint: 'Ctrl+Shift+K',
        onClick: () => handle?.term.clear()
      },
      { separator: true },
      { label: 'Разделить вправо', hint: 'Ctrl+Shift+D', onClick: () => void store.splitActive('row') },
      { label: 'Разделить вниз', hint: 'Ctrl+Shift+S', onClick: () => void store.splitActive('col') },
      { separator: true },
      {
        label: 'Закрыть панель',
        danger: true,
        onClick: () => void store.closeSession(sessionId)
      }
    ])
  }

  return (
    <div
      className={`zy-pane${active ? ' zy-pane--focused' : multiPane ? ' zy-pane--dim' : ''}`}
      onMouseDown={() => {
        if (!active) store.setActiveSession(sessionId)
      }}
      onContextMenu={onContextMenu}
    >
      <PaneHeader sessionId={sessionId} />
      <XtermView sessionId={sessionId} active={active} visible={visible} />
      {searchOpenFor === sessionId && <TermSearchBar sessionId={sessionId} />}
      {menu}
    </div>
  )
}

/**
 * Thin instrument-panel strip above the xterm surface: "★ CLI-АГЕНТ · ЗАРЯ"
 * mark, the pane's own cwd, split + search shortcuts. One per pane (not per
 * split gutter) so every terminal keeps its own working-directory readout.
 */
function PaneHeader({ sessionId }: { sessionId: string }): React.JSX.Element {
  const cwd = useSessionsStore((s) => s.sessions[sessionId]?.cwd)
  const searchOpenFor = useUiStore((s) => s.searchOpenFor)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '6px 10px',
        flexShrink: 0,
        background: 'color-mix(in srgb, var(--panel) 60%, transparent)',
        borderBottom: '1px solid var(--border)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ display: 'inline-flex', color: 'var(--accent)', flexShrink: 0 }}>
          <Icon name="star" size={12} />
        </span>
        <span
          style={{
            fontFamily: 'var(--font-tech)',
            fontSize: 13,
            letterSpacing: '0.1em',
            color: 'var(--accent)',
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
        >
          CLI-АГЕНТ · ЗАРЯ
        </span>
        {cwd && (
          <span
            title={cwd}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--fg-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {cwd}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <button
          className="zy-icon-btn"
          title="Разделить вправо"
          onClick={() => void useSessionsStore.getState().splitActive('row')}
        >
          <Icon name="split-h" size={13} />
        </button>
        <button
          className={`zy-icon-btn${searchOpenFor === sessionId ? ' zy-icon-btn--active' : ''}`}
          title="Найти в терминале"
          onClick={() =>
            useUiStore.getState().set({ searchOpenFor: searchOpenFor === sessionId ? null : sessionId })
          }
        >
          <Icon name="search" size={13} />
        </button>
      </div>
    </div>
  )
}

function TermSearchBar({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const close = (): void => {
    getTerminal(sessionId)?.search.clearDecorations()
    useUiStore.getState().set({ searchOpenFor: null })
    getTerminal(sessionId)?.focus()
  }

  const find = (dir: 1 | -1): void => {
    const handle = getTerminal(sessionId)
    if (!handle || !query) return
    const opts = { decorations: { matchOverviewRuler: '#ff8a4c', activeMatchColorOverviewRuler: '#ffb86b' } }
    if (dir === 1) handle.search.findNext(query, opts)
    else handle.search.findPrevious(query, opts)
  }

  return (
    <div className="zy-searchbar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Поиск…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') close()
        }}
      />
      <button className="zy-icon-btn" title="Назад (Shift+Enter)" onClick={() => find(-1)}>
        <Icon name="chevron-up" size={13} />
      </button>
      <button className="zy-icon-btn" title="Далее (Enter)" onClick={() => find(1)}>
        <Icon name="chevron-down" size={13} />
      </button>
      <button className="zy-icon-btn" title="Закрыть (Esc)" onClick={close}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
