import { useEffect, useState } from 'react'
import type { GitStatus } from '@shared/types'
import { onBus } from '@/lib/bus'
import { shortenPath, formatRelative } from '@/lib/ansi'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { useContextMenu } from './ContextMenu'
import { Icon } from './Icon'

const sepStyle: React.CSSProperties = { borderLeft: '1px solid var(--border)', borderRadius: 0 }

export function StatusBar(): React.JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const settings = useSettingsStore((s) => s.settings)
  const { menu, open } = useContextMenu()
  const [git, setGit] = useState<GitStatus | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [, forceTick] = useState(0)

  const activeSessionId = tabs.find((t) => t.id === activeTabId)?.activeSessionId ?? null
  const session = activeSessionId ? sessions[activeSessionId] : null
  const cwd = session?.cwd ?? ''

  // git status: refresh on cwd change and after each finished block
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      if (!cwd) {
        setGit(null)
        return
      }
      void window.zarya.git.status(cwd).then((g) => {
        if (alive) setGit(g)
      })
    }
    refresh()
    const unsub = onBus('block:finished', ({ sessionId }) => {
      if (sessionId === activeSessionId) refresh()
    })
    const unsubCwd = onBus('terminal:cwd-changed', ({ sessionId }) => {
      if (sessionId === activeSessionId) refresh()
    })
    return () => {
      alive = false
      unsub()
      unsubCwd()
    }
  }, [cwd, activeSessionId])

  // autosave indicator ticks
  useEffect(() => {
    const iv = setInterval(() => forceTick((x) => x + 1), 15000)
    const unsub = useSessionsStore.subscribe(() => setSavedAt(Date.now()))
    return () => {
      clearInterval(iv)
      unsub()
    }
  }, [])

  const writeCd = (path: string): void => {
    if (!activeSessionId) return
    const quoted = path.includes(' ') ? `"${path}"` : path
    window.zarya.pty.write(activeSessionId, `cd ${quoted}\r`)
    getTerminal(activeSessionId)?.focus()
  }

  const openBookmarks = (e: React.MouseEvent): void => {
    const bookmarks = settings.bookmarks
    const items = [
      ...(cwd
        ? [
            {
              label: bookmarks.includes(cwd) ? 'Убрать закладку' : 'Закладка на эту папку',
              onClick: () => {
                const next = bookmarks.includes(cwd)
                  ? bookmarks.filter((b) => b !== cwd)
                  : [...bookmarks, cwd]
                void useSettingsStore.getState().update({ bookmarks: next })
              }
            },
            {
              label: 'Открыть в проводнике',
              onClick: () => window.zarya.app.showItemInFolder(cwd)
            },
            { separator: true as const }
          ]
        : []),
      ...bookmarks.map((b) => ({
        label: shortenPath(b, 44),
        onClick: () => writeCd(b)
      }))
    ]
    if (!items.length) return
    open(e.clientX, e.clientY, items)
  }

  return (
    <footer className="zy-statusbar">
      {cwd && (
        <button className="zy-status-item zy-status-item--btn" onClick={openBookmarks} title={cwd}>
          <Icon name="folder" size={12.5} />
          <span style={{ fontFamily: 'var(--font-mono)' }}>{shortenPath(cwd, 46)}</span>
        </button>
      )}
      {git && (
        <span
          className="zy-status-item"
          style={sepStyle}
          title={`Ветка ${git.branch} · изменений: ${git.dirty}${git.ahead ? ` · ↑${git.ahead}` : ''}${git.behind ? ` · ↓${git.behind}` : ''}`}
        >
          <Icon name="branch" size={12.5} />
          {git.branch}
          {git.dirty > 0 && <span style={{ color: 'var(--warn)' }}>±{git.dirty}</span>}
          {git.ahead > 0 && <span>↑{git.ahead}</span>}
          {git.behind > 0 && <span>↓{git.behind}</span>}
        </span>
      )}
      <div className="zy-status-spacer" />
      {savedAt && (
        <span
          className="zy-status-item zy-status-saved"
          style={sepStyle}
          title="Автосохранение сессий"
        >
          сохранено · {formatRelative(savedAt)}
        </span>
      )}
      {session && (
        <span className="zy-status-item" style={sepStyle}>
          {session.shellName || '…'}
          {session.integration && (
            <span title="Shell integration активна" style={{ color: 'var(--success)' }}>
              ●
            </span>
          )}
        </span>
      )}
      <button
        className="zy-status-item zy-status-item--btn zy-status-fuel"
        style={sepStyle}
        title="Топливо · борт"
        onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
      >
        <Icon name="rocket" size={12.5} />∞ борт
      </button>
      <button
        className="zy-status-item zy-status-item--btn zy-status-model"
        style={sepStyle}
        title="Двигатель · модель и тяга (пусковой комплекс)"
        onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
      >
        <Icon name="orbit" size={12.5} />
        {settings.ai.model}
      </button>
      {menu}
    </footer>
  )
}
