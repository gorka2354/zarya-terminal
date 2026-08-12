import { useEffect, useState } from 'react'
import { forgetProject, rememberProject } from '@/actions/projects'
import { samePath } from '@shared/projects'
import type { GitStatus } from '@shared/types'
import { onBus } from '@/lib/bus'
import { shortenPath, formatRelative } from '@/lib/ansi'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { t, useLang } from '@/lib/i18n'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { useContextMenu } from './ContextMenu'
import { Icon } from './Icon'

const sepStyle: React.CSSProperties = { borderLeft: '1px solid var(--border)', borderRadius: 0 }

export function StatusBar(): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

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
              label: t(
                bookmarks.some((b) => samePath(b, cwd)) ? 'status.unbookmark' : 'status.bookmark'
              ),
              onClick: () => {
                const known = bookmarks.find((b) => samePath(b, cwd))
                if (known) void forgetProject(known)
                else void rememberProject(cwd)
              }
            },
            {
              label: t('projects.showInExplorer'),
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
          title={`${t('status.branch', { name: git.branch })} · ${t('status.dirty', { n: git.dirty })}${git.ahead ? ` · ↑${git.ahead}` : ''}${git.behind ? ` · ↓${git.behind}` : ''}`}
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
          title={t('status.autosave')}
        >
          {t('status.saved')} · {formatRelative(savedAt)}
        </span>
      )}
      {session && (
        <span className="zy-status-item" style={sepStyle}>
          {session.shellName || '…'}
          {session.integration && (
            <span title={t('status.shellIntegration')} style={{ color: 'var(--success)' }}>
              ●
            </span>
          )}
        </span>
      )}
      {menu}
    </footer>
  )
}
