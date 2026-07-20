import { useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { formatRelative, shortenPath } from '@/lib/ansi'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import '../palette/palette.css'

const SEARCH_LIMIT = 60
const DEBOUNCE_MS = 120

/**
 * Sidebar Time Machine: same global history search as the overlay, plus
 * quick filters (errors only / current folder only) for browsing at rest.
 */
export default function HistoryPanel(): React.JSX.Element {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId())
  const sessions = useSessionsStore((s) => s.sessions)
  const currentCwd = (activeSessionId && sessions[activeSessionId]?.cwd) || ''
  const toast = useUiStore((s) => s.toast)

  const [query, setQuery] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [currentDirOnly, setCurrentDirOnly] = useState(false)
  const [results, setResults] = useState<HistoryEntry[]>([])
  const reqGen = useRef(0)

  useEffect(() => {
    const gen = ++reqGen.current
    const t = setTimeout(() => {
      void window.zarya.history.search(query, SEARCH_LIMIT).then((entries) => {
        if (reqGen.current !== gen) return
        setResults(entries)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const filtered = results.filter((e) => {
    if (errorsOnly && !(e.exitCode !== undefined && e.exitCode !== 0)) return false
    if (currentDirOnly && e.cwd !== currentCwd) return false
    return true
  })

  const insert = (entry: HistoryEntry, run: boolean): void => {
    if (!activeSessionId) return
    window.zarya.pty.write(activeSessionId, run ? entry.command + '\r' : entry.command)
    getTerminal(activeSessionId)?.focus()
  }

  const copy = (entry: HistoryEntry): void => {
    void navigator.clipboard.writeText(entry.command)
    toast('Команда скопирована', 'success')
  }

  return (
    <>
      <div className="zy-sidebar-header">
        <span>История</span>
      </div>
      <div className="zy-sidebar-search">
        <input
          className="zy-input zy-input--mono"
          placeholder="Поиск по истории…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="zy-history-filters">
        <label className="zy-history-filter">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          Только ошибки
        </label>
        <label className="zy-history-filter">
          <input
            type="checkbox"
            checked={currentDirOnly}
            onChange={(e) => setCurrentDirOnly(e.target.checked)}
            disabled={!currentCwd}
          />
          Только текущая папка
        </label>
      </div>
      <div className="zy-sidebar-body" role="listbox" aria-label="История команд">
        {!filtered.length && (
          <div className="zy-empty">
            {results.length ? 'Ничего не подходит под фильтры' : 'История команд пуста'}
          </div>
        )}
        {filtered.map((entry) => (
          <div
            key={entry.id}
            role="option"
            aria-selected={false}
            className="zy-item"
            title={entry.command}
            onClick={() => insert(entry, false)}
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
            <div className="zy-item-body">
              <div className="zy-item-title zy-history-item-cmd">{entry.command}</div>
              <div className="zy-item-sub">
                {shortenPath(entry.cwd, 30)} · {formatRelative(entry.at)}
              </div>
            </div>
            <div className="zy-item-actions">
              <button
                className="zy-icon-btn"
                title="Запустить"
                onClick={(e) => {
                  e.stopPropagation()
                  insert(entry, true)
                }}
              >
                ↻
              </button>
              <button
                className="zy-icon-btn"
                title="Скопировать"
                onClick={(e) => {
                  e.stopPropagation()
                  copy(entry)
                }}
              >
                ⧉
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
