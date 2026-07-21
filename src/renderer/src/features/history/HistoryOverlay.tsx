import { useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { formatRelative, shortenPath } from '@/lib/ansi'
import { Icon } from '@/components/Icon'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import '../palette/palette.css'

const SEARCH_LIMIT = 60
const DEBOUNCE_MS = 120

/**
 * Time Machine (Ctrl+R): global command history across every session,
 * searchable, with quick insert-or-run into the active terminal.
 */
export default function HistoryOverlay(): React.JSX.Element | null {
  const open = useUiStore((s) => s.historyOverlayOpen)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId())

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [results, setResults] = useState<HistoryEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const reqGen = useRef(0)

  const runSearch = (q: string): void => {
    const gen = ++reqGen.current
    void window.zarya.history.search(q, SEARCH_LIMIT).then((entries) => {
      if (reqGen.current !== gen) return
      setResults(entries)
      setSelectedIndex(0)
    })
  }

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setSelectedIndex(0)
    runSearch('')
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(id)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => runSearch(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const commit = (entry: HistoryEntry | undefined, run: boolean): void => {
    if (!entry || !activeSessionId) return
    window.zarya.pty.write(activeSessionId, run ? entry.command + '\r' : entry.command)
    useUiStore.getState().set({ historyOverlayOpen: false })
    getTerminal(activeSessionId)?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      useUiStore.getState().set({ historyOverlayOpen: false })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(results[selectedIndex], e.ctrlKey)
    }
  }

  if (!open) return null

  return (
    <div
      className="zy-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useUiStore.getState().set({ historyOverlayOpen: false })
      }}
    >
      <div className="zy-modal zy-modal--wide" role="dialog" aria-label="История команд">
        <div className="zy-palette-input-row">
          <span className="zy-palette-input-icon">
            <Icon name="history" size={15} strokeWidth={1.6} />
          </span>
          <input
            ref={inputRef}
            className="zy-palette-input zy-palette-input--mono"
            placeholder="Поиск по истории команд, во всех сессиях…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls="zy-history-listbox"
            aria-activedescendant={
              results[selectedIndex] ? `zy-history-opt-${results[selectedIndex].id}` : undefined
            }
          />
        </div>
        <div className="zy-palette-list" role="listbox" id="zy-history-listbox">
          {!results.length && <div className="zy-empty">Совпадений не найдено</div>}
          {results.map((entry, index) => (
            <div
              key={entry.id}
              id={`zy-history-opt-${entry.id}`}
              role="option"
              aria-selected={index === selectedIndex}
              className={`zy-palette-item${index === selectedIndex ? ' zy-palette-item--selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={(e) => commit(entry, e.ctrlKey)}
            >
              <span
                className={`zy-badge ${
                  entry.exitCode === undefined
                    ? ''
                    : entry.exitCode === 0
                      ? 'zy-badge--ok'
                      : 'zy-badge--fail'
                }`}
              >
                {entry.exitCode === undefined ? '⋯' : entry.exitCode === 0 ? '✓' : `✗${entry.exitCode}`}
              </span>
              <div className="zy-palette-item-body">
                <div className="zy-palette-item-title zy-palette-item-title--mono">
                  {entry.command}
                </div>
                <div className="zy-palette-item-sub">{shortenPath(entry.cwd, 44)}</div>
              </div>
              <span className="zy-palette-item-meta">{formatRelative(entry.at)}</span>
            </div>
          ))}
        </div>
        <div className="zy-palette-footer">
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">↑↓</span> навигация
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">Enter</span> вставить
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">Ctrl+Enter</span> вставить и запустить
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">Esc</span> закрыть
          </span>
        </div>
      </div>
    </div>
  )
}
