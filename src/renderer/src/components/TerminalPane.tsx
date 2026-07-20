import { useEffect, useRef, useState } from 'react'
import { XtermView } from '@/terminal/XtermView'
import { getTerminal } from '@/terminal/terminalRegistry'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useContextMenu } from './ContextMenu'

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
      <XtermView sessionId={sessionId} active={active} visible={visible} />
      {searchOpenFor === sessionId && <TermSearchBar sessionId={sessionId} />}
      {menu}
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
        ↑
      </button>
      <button className="zy-icon-btn" title="Далее (Enter)" onClick={() => find(1)}>
        ↓
      </button>
      <button className="zy-icon-btn" title="Закрыть (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  )
}
