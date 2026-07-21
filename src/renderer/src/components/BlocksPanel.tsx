import type { BlockRecord } from '@shared/types'
import { formatDuration, formatRelative } from '@/lib/ansi'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { aiExplainBlock } from '@/features/ai/aiBridge'
import { Icon } from './Icon'

/**
 * Command blocks of the active session as cards (Warp-style):
 * click to scroll, copy command/output, re-run, ask AI about a failure.
 */
export function BlocksPanel(): React.JSX.Element {
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const sessionId = tabs.find((t) => t.id === activeTabId)?.activeSessionId ?? null
  const blocks = useBlocksStore((s) => (sessionId ? (s.bySession[sessionId] ?? []) : []))
  const toast = useUiStore((s) => s.toast)

  const rerun = (b: BlockRecord): void => {
    if (!sessionId || !b.command) return
    window.zarya.pty.write(sessionId, b.command + '\r')
    getTerminal(sessionId)?.focus()
  }

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text)
    toast(`${what} скопирован`, 'success')
  }

  const exportMd = (b: BlockRecord): void => {
    const md = `\`\`\`\n$ ${b.command}\n${b.output}\n\`\`\`\n_exit ${b.exitCode ?? '—'} · ${new Date(b.startedAt).toLocaleString()}_`
    copy(md, 'Markdown')
  }

  return (
    <>
      <div className="zy-sidebar-header">
        <span>Блоки</span>
        <button
          className="zy-icon-btn"
          title="Закрыть"
          onClick={() => useUiStore.getState().set({ blocksPanelOpen: false })}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="zy-sidebar-body">
        {!blocks.length && (
          <div className="zy-empty">
            Блоки команд появятся здесь после первого запуска команды (нужна shell
            integration — PowerShell/bash/zsh).
          </div>
        )}
        {[...blocks].reverse().map((b) => (
          <div
            key={b.id}
            className="zy-block-card"
            onClick={() => sessionId && getTerminal(sessionId)?.engine.scrollToBlock(b.id)}
          >
            <div className="zy-block-card-head">
              <span
                className={`zy-badge ${
                  b.exitCode === undefined
                    ? ''
                    : b.exitCode === 0
                      ? 'zy-badge--ok'
                      : 'zy-badge--fail'
                }`}
              >
                {b.exitCode === undefined ? '⋯' : b.exitCode === 0 ? '✓' : `✗ ${b.exitCode}`}
              </span>
              <span className="zy-block-card-cmd" title={b.command}>
                {b.command || '(команда неизвестна)'}
              </span>
            </div>
            {b.output && <pre className="zy-block-card-out">{b.output.slice(-400)}</pre>}
            <div className="zy-block-card-foot">
              <span className="zy-block-card-meta">
                {formatRelative(b.startedAt)}
                {b.endedAt ? ` · ${formatDuration(b.endedAt - b.startedAt)}` : ''}
              </span>
              <span className="zy-block-card-actions">
                <button
                  className="zy-icon-btn"
                  title="Скопировать команду"
                  onClick={(e) => {
                    e.stopPropagation()
                    copy(b.command, 'Команда')
                  }}
                >
                  <Icon name="copy" size={13} />
                </button>
                <button
                  className="zy-icon-btn"
                  title="Скопировать вывод"
                  onClick={(e) => {
                    e.stopPropagation()
                    copy(b.output, 'Вывод')
                  }}
                >
                  <Icon name="download" size={13} />
                </button>
                <button
                  className="zy-icon-btn"
                  title="Экспорт в Markdown"
                  onClick={(e) => {
                    e.stopPropagation()
                    exportMd(b)
                  }}
                >
                  <Icon name="download" size={13} />
                </button>
                <button
                  className="zy-icon-btn"
                  title="Повторить команду"
                  onClick={(e) => {
                    e.stopPropagation()
                    rerun(b)
                  }}
                >
                  <Icon name="rerun" size={13} />
                </button>
                <button
                  className="zy-icon-btn"
                  title="Спросить AI об этом блоке"
                  onClick={(e) => {
                    e.stopPropagation()
                    aiExplainBlock(b)
                  }}
                >
                  <Icon name="sputnik" size={13} />
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
