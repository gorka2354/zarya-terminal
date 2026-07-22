import { useRef, useState } from 'react'
import type { AiEffort } from '@shared/types'
import { EFFORT_TUNING } from '@shared/defaults'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { useAiStore } from '@/features/ai/aiStore'
import { Icon } from './Icon'
import './agentbar.css'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/** claude-haiku-4-5-20251001 → HAIKU 4.5 — a compact chip label. */
function prettyModel(id: string): string {
  return id
    .replace(/^claude-/, '')
    .replace(/-\d{6,}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-/g, ' ')
    .toUpperCase()
}

/**
 * Unified "ask agent" command bar under the terminal area — the design's
 * signature bottom input. Plain text goes to the AI agent (opens the panel and
 * sends); a line starting with `$` is a shell command written straight to the
 * active terminal. The model chip opens the Launch Pad; a fuel strip sits on
 * top.
 */
export function AgentBar(): React.JSX.Element {
  const model = useSettingsStore((s) => s.settings.ai.model)
  const effort = useSettingsStore((s) => s.settings.ai.effort)
  const effortIdx = EFFORTS.indexOf(effort)
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  const activeSessionId = useSessionsStore((s) => s.activeSessionId())

  const submit = (): void => {
    const raw = text.trim()
    if (!raw) return
    setText('')
    if (raw.startsWith('$')) {
      // Shell command → active terminal.
      const cmd = raw.slice(1).trim()
      if (activeSessionId && cmd) {
        window.zarya.pty.write(activeSessionId, cmd + '\r')
        getTerminal(activeSessionId)?.focus()
      }
      return
    }
    // Otherwise → AI agent. The turn renders inline in the mission feed (no
    // side panel) — bind the conversation to the active session so the feed
    // picks it up.
    const store = useAiStore.getState()
    const conv = store.activeConversation()
    const convId =
      conv && !conv.streaming
        ? conv.id
        : store.newConversation({ sessionId: activeSessionId ?? undefined })
    void store.send(raw, { conversationId: convId })
  }

  const openLaunchPad = (): void => useUiStore.getState().set({ launchPadOpen: true })

  return (
    <div className="zy-agentbar">
      <button
        className="zy-agentbar-fuel"
        title="Топливо · пусковой комплекс"
        onClick={openLaunchPad}
      >
        <span className="zy-agentbar-fuel-icon">
          <svg width="10" height="10" viewBox="0 0 16 16" shapeRendering="crispEdges" fill="var(--accent-2)">
            <rect x="4" y="2" width="6" height="2" />
            <rect x="4" y="4" width="6" height="9" />
            <rect x="10" y="5" width="3" height="2" />
            <rect x="12" y="6" width="1" height="4" />
          </svg>
        </span>
        <span className="zy-agentbar-fuel-tag">ТОПЛИВО</span>
        <span className="zy-agentbar-fuel-val">∞ без лимита · локальный борт</span>
        <span className="zy-agentbar-fuel-spacer" />
        <span className="zy-agentbar-fuel-pult">пульт ▴</span>
      </button>

      <div className="zy-agentbar-row">
        <span
          className="zy-agentbar-star"
          title="Ввод уходит агенту · начните строку с $ для shell-команды"
        >
          <Icon name="bolt" size={14} />
        </span>
        <input
          ref={ref}
          className="zy-agentbar-input"
          placeholder="Спросите агента…  ($ в начале — shell-команда)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          className={`zy-agentbar-effort${effort === 'max' ? ' zy-agentbar-effort--max' : ''}`}
          title={`Тяга (effort): ${EFFORT_TUNING[effort].label} · пусковой комплекс`}
          onClick={openLaunchPad}
        >
          <span className="zy-agentbar-effort-bars">
            {EFFORTS.map((e, i) => (
              <span
                key={e}
                className={`zy-agentbar-effort-bar${i <= effortIdx ? ' zy-agentbar-effort-bar--on' : ''}`}
              />
            ))}
          </span>
          <span className="zy-agentbar-effort-label">{EFFORT_TUNING[effort].label}</span>
        </button>
        <button
          className="zy-agentbar-model"
          title={`Двигатель · модель: ${model} (пусковой комплекс)`}
          onClick={openLaunchPad}
        >
          <span className="zy-agentbar-model-name">{prettyModel(model)}</span>
          <span className="zy-agentbar-model-caret">▴</span>
        </button>
        <button className="zy-agentbar-send" title="Отправить агенту" onClick={submit}>
          <Icon name="send" size={16} />
        </button>
      </div>
    </div>
  )
}
