import { useEffect, useState } from 'react'
import type { AiCli } from '@shared/types'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import './aiclilauncher.css'

let cliCache: AiCli[] | null = null

/** Fetch the AI-CLI list once and memoize it for the renderer lifetime. */
function useAiClis(): AiCli[] {
  const [clis, setClis] = useState<AiCli[]>(cliCache ?? [])
  useEffect(() => {
    if (cliCache) return
    let alive = true
    void window.zarya.aiClis.detect().then((list) => {
      cliCache = list
      if (alive) setClis(list)
    })
    return () => {
      alive = false
    }
  }, [])
  return clis
}

/**
 * Turn on Claude Code as the native agent engine (no raw TUI): the ⚡ bar talks
 * to the headless driver, tool/choice prompts render natively. Creates/activates
 * a Claude Code conversation bound to the active session.
 */
export function launchClaudeNative(): void {
  const sessionId = useSessionsStore.getState().activeSessionId()
  useUiStore.getState().set({ barMode: 'claude-code', rawTerminal: false })
  const store = useAiStore.getState()
  // Reuse this terminal's Claude conversation if it already exists & is idle,
  // otherwise start a fresh one bound to the active terminal.
  const existing = convForSession(store, sessionId)
  if (!existing || existing.engine !== 'claude-code') {
    const id = store.newConversation({ sessionId: sessionId ?? undefined, engine: 'claude-code', title: 'Claude Code' })
    store.setActiveConversation(id)
  } else {
    store.setActiveConversation(existing.id)
  }
  useUiStore.getState().toast('Claude Code активен — просто напишите запрос и нажмите Enter', 'success')
}

/**
 * Launch an AI CLI. Claude Code runs NATIVELY (structured, native choice
 * widgets, subscription login). Other CLIs launch into the live «Терминал» as
 * their raw TUI (write the command + focus).
 */
export function launchAiCli(cli: AiCli): void {
  if (cli.id === 'claude') {
    launchClaudeNative()
    return
  }
  const sessionId = useSessionsStore.getState().activeSessionId()
  if (!sessionId) return
  useUiStore.getState().set({ rawTerminal: true })
  window.zarya.pty.write(sessionId, cli.cmd + '\r')
  setTimeout(() => getTerminal(sessionId)?.focus(), 80)
}

/**
 * Grid of AI coding CLIs (Claude Code, Codex, Gemini…). Installed ones launch
 * on click; missing ones are dimmed with an install hint. Shown on the empty
 * feed hero as the primary "get started with an agent" surface.
 */
export function AiCliLauncher(): React.JSX.Element | null {
  const clis = useAiClis()
  if (clis.length === 0) return null
  const installed = clis.filter((c) => c.detected)
  const missing = clis.filter((c) => !c.detected)
  // Show installed first; if none are installed, still surface the known set so
  // the user knows what Zarya supports.
  const shown = installed.length > 0 ? installed : missing

  return (
    <div className="zy-clilaunch">
      <div className="zy-clilaunch-label">
        {installed.length > 0 ? 'запустить ИИ-агента в терминале' : 'поддерживаемые ИИ-агенты (не установлены)'}
      </div>
      <div className="zy-clilaunch-grid">
        {shown.map((cli) => (
          <button
            key={cli.id}
            className={`zy-clilaunch-tile${cli.detected ? '' : ' zy-clilaunch-tile--off'}`}
            title={
              cli.detected
                ? cli.id === 'claude'
                  ? 'Claude Code — нативно (структурный UI, выбор в строке, подписка Max)'
                  : `Запустить в терминале: ${cli.cmd}`
                : `${cli.name} не найден в PATH — установите CLI, чтобы запускать здесь`
            }
            disabled={!cli.detected}
            onClick={() => cli.detected && launchAiCli(cli)}
          >
            <span className={`zy-clilaunch-glyph zy-clilaunch-glyph--${cli.tint}`}>{cli.glyph}</span>
            <span className="zy-clilaunch-name">{cli.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
