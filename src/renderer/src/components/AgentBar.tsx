import { useEffect, useRef, useState } from 'react'
import type { AiEffort, ClaudeCliQuestion } from '@shared/types'
import { EFFORT_TUNING } from '@shared/defaults'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { Icon } from './Icon'
import { ClaudeQuestionBar } from './ClaudeQuestionBar'
import { launchClaudeNative } from './AiCliLauncher'
import './agentbar.css'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

// Session-local input history for the bottom bar (↑/↓ recall, like a shell).
// Module-level so it survives AgentBar remounts within the session.
const barHistory: string[] = []
function pushHistory(text: string): void {
  const t = text.trim()
  if (!t || barHistory[barHistory.length - 1] === t) return
  barHistory.push(t)
  if (barHistory.length > 200) barHistory.shift()
}

type BarMode = 'shell' | 'zarya' | 'claude-code'
// Everyday toggle is just Терминал ⇄ Claude Code. «Zarya» (own-key / Ollama
// agent) is a niche — the bar still enters it automatically when a Zarya
// conversation is active (auto-follow), but it doesn't clutter the manual cycle.
const MODE_ORDER: BarMode[] = ['shell', 'claude-code']
const MODE_LABEL: Record<BarMode, string> = {
  shell: 'ТЕРМИНАЛ',
  zarya: 'ZARYA',
  'claude-code': 'CLAUDE CODE'
}
const MODE_PLACEHOLDER: Record<BarMode, string> = {
  shell: 'Команда терминала…  (Enter — выполнить)',
  zarya: 'Спросить агента Zarya…  (Enter)',
  'claude-code': 'Спросить Claude Code…  (Enter, нативно, подписка Max)'
}

// Commands that take over the terminal (TUI / raw input) → auto-switch to the
// live «Терминал» view so arrows/prompts work.
const INTERACTIVE_CMDS = new Set([
  'claude', 'gemini', 'codex', 'aider', 'cursor-agent', 'ollama',
  'vim', 'nvim', 'vi', 'nano', 'emacs',
  'less', 'more', 'top', 'htop', 'btop',
  'ssh', 'tmux', 'screen', 'fzf', 'lazygit', 'lazydocker',
  'python', 'python3', 'node', 'irb', 'psql', 'mysql', 'sqlite3', 'redis-cli'
])
function isInteractiveCmd(cmd: string): boolean {
  const first = cmd
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase()
  return !!first && INTERACTIVE_CMDS.has(first)
}

/** claude-haiku-4-5-20251001 → HAIKU 4.5 — a compact chip label. */
function prettyModel(id: string): string {
  return id
    .replace(/^claude-/, '')
    .replace(/-\d{6,}$/, '')
    .replace(/\[1m\]$/i, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-/g, ' ')
    .toUpperCase()
}

function resetLabel(ts?: number): string {
  if (!ts) return ''
  const mins = Math.round((ts - Date.now()) / 60000)
  if (mins <= 0) return 'скоро'
  if (mins < 60) return `${mins}м`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}ч ${m}м` : `${h}ч`
}

/**
 * Pixel fuel gauge: 10 cells that DRAIN as the subscription window fills.
 * `used` is the utilization % (0-100); the tank shows the remaining fuel and
 * reddens as it empties.
 */
function FuelGauge({ used }: { used: number }): React.JSX.Element {
  const remaining = Math.max(0, Math.min(100, 100 - used))
  const cells = Math.round((remaining / 100) * 10)
  const level = remaining > 40 ? 'ok' : remaining > 15 ? 'warn' : 'low'
  return (
    <span className={`zy-fuel-gauge zy-fuel-gauge--${level}`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={`zy-fuel-cell${i < cells ? ' zy-fuel-cell--on' : ''}`} />
      ))}
    </span>
  )
}

/**
 * Bottom bar with an explicit mode chip: «Терминал» runs commands in the shell
 * (Warp-style), «Zarya» / «Claude Code» send your text to that agent on Enter.
 * When Claude Code raises an AskUserQuestion the whole bar morphs into
 * {@link ClaudeQuestionBar} — the single input becomes a native choice selector.
 */
export function AgentBar(): React.JSX.Element {
  const model = useSettingsStore((s) => s.settings.ai.model)
  const effort = useSettingsStore((s) => s.settings.ai.effort)
  const effortIdx = EFFORTS.indexOf(effort)
  const mode = useUiStore((s) => s.barMode)
  const claudeStatus = useUiStore((s) => s.claudeStatus)
  const ultracode = useUiStore((s) => s.ultracode)
  const bypass = useSettingsStore((s) => s.settings.ai.claudeBypass)
  const [text, setText] = useState('')
  // -1 = not browsing history; otherwise index into barHistory.
  const [histIdx, setHistIdx] = useState(-1)
  const draftRef = useRef('')
  const ref = useRef<HTMLInputElement>(null)

  const activeSessionId = useSessionsStore((s) => s.activeSessionId())
  // The conversation belongs to the active terminal — each terminal its own chat.
  const activeConv = useAiStore((s) => convForSession(s, activeSessionId))

  // Global keys (window-active, focus-independent): Esc interrupts the working
  // agent; Enter/Esc approve/deny a pending tool. Skipped while an overlay owns
  // Esc, in raw terminal mode, or during a pending choice (the choice bar owns it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      const ui = useUiStore.getState()
      if (
        ui.paletteOpen ||
        ui.settingsOpen ||
        ui.launchPadOpen ||
        ui.quickOpenOpen ||
        ui.historyOverlayOpen ||
        ui.aiBarOpen ||
        ui.rawTerminal
      )
        return
      const sid = useSessionsStore.getState().activeSessionId()
      const conv = convForSession(useAiStore.getState(), sid)
      if (!conv) return
      // A tool call awaiting approval: Enter (empty input) approves, Esc denies —
      // CLI-style, no reaching for the mouse. Takes precedence over interrupt.
      const pendingRun = conv.pendingTools.find((t) => !t.settled && t.kind !== 'question')
      if (pendingRun) {
        if (e.key === 'Escape') {
          e.preventDefault()
          useAiStore.getState().denyTool(conv.id, pendingRun.id)
          return
        }
        const ae = document.activeElement as HTMLElement | null
        const inOtherField =
          !!ae &&
          ae !== ref.current &&
          (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (e.key === 'Enter' && !inOtherField && !ref.current?.value.trim()) {
          e.preventDefault()
          void useAiStore.getState().approveTool(conv.id, pendingRun.id)
          return
        }
      }
      if (e.key !== 'Escape') return
      if (!conv.streaming) return
      if (conv.pendingTools.some((t) => t.kind === 'question' && !t.settled)) return
      e.preventDefault()
      useAiStore.getState().abort(conv.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Auto-follow: when an agent conversation becomes active (selected, or you
  // start chatting), the bar switches to that engine's mode by itself — no
  // hunting for the chip. Guarded by convId so a manual override still sticks
  // within the same conversation.
  const followedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeConv) return
    const isAgentConv = activeConv.messages.length > 0 || activeConv.streaming
    if (!isAgentConv) return
    if (followedRef.current === activeConv.id) return
    followedRef.current = activeConv.id
    const want: BarMode = activeConv.engine === 'claude-code' ? 'claude-code' : 'zarya'
    if (useUiStore.getState().barMode !== want) useUiStore.getState().set({ barMode: want })
  }, [activeConv?.id, activeConv?.engine, activeConv?.messages.length, activeConv?.streaming])

  // A pending AskUserQuestion on the active Claude Code conversation replaces
  // the whole input area with the native choice selector.
  const question =
    activeConv?.engine === 'claude-code'
      ? activeConv.pendingTools.find((t) => t.kind === 'question' && !t.settled)
      : undefined

  const runShell = (): void => {
    const cmd = text.trim()
    if (!cmd || !activeSessionId) return
    pushHistory(cmd)
    setHistIdx(-1)
    // Auto-detect intent: a bare `claude` means "I want to work with Claude" —
    // switch straight into the native mode instead of the raw TUI (add args,
    // e.g. `claude --version`, to still run the real CLI in the terminal).
    if (/^claude$/i.test(cmd)) {
      setText('')
      launchClaudeNative()
      return
    }
    setText('')
    if (isInteractiveCmd(cmd)) {
      useUiStore.getState().set({ rawTerminal: true })
      setTimeout(() => getTerminal(activeSessionId)?.focus(), 60)
    }
    window.zarya.pty.write(activeSessionId, cmd + '\r')
  }

  const askAgent = (agentEngine: 'builtin' | 'claude-code'): void => {
    const q = text.trim()
    if (!q) return
    pushHistory(q)
    setHistIdx(-1)
    setText('')
    const store = useAiStore.getState()
    // Continue this terminal's own conversation (if it matches the engine and is
    // idle), otherwise start a fresh one bound to the active terminal session.
    const conv = convForSession(store, activeSessionId)
    const reuse =
      conv && conv.engine === agentEngine && !conv.streaming && conv.pendingTools.length === 0
    const convId = reuse
      ? conv!.id
      : store.newConversation({ sessionId: activeSessionId ?? undefined, engine: agentEngine })
    if (store.activeConversation()?.id !== convId) store.setActiveConversation(convId)
    void store.send(q, { conversationId: convId })
  }

  // Only "busy" (queue instead of send) when the active conversation's engine
  // matches what THIS bar mode targets — not e.g. a background Zarya chat while
  // the bar is in Claude Code mode.
  const modeEngine = mode === 'claude-code' ? 'claude-code' : mode === 'zarya' ? 'builtin' : null
  const busyConv =
    !!modeEngine &&
    activeConv?.engine === modeEngine &&
    (activeConv.streaming || activeConv.pendingTools.some((t) => t.settled))

  const doAction = (): void => {
    if (mode === 'shell') {
      runShell()
      return
    }
    const engine = mode === 'claude-code' ? 'claude-code' : 'builtin'
    // Agent working on THIS terminal → queue the message (editable via ↑), CLI-style.
    if (activeConv && activeConv.engine === engine && busyConv) {
      const t = text.trim()
      if (t) {
        pushHistory(t)
        setHistIdx(-1)
        useAiStore.getState().queueMessage(activeConv.id, t)
        setText('')
      }
      return
    }
    askAgent(engine)
  }

  // CLI-style keys: ↑ first pulls a queued message back to edit, then walks input
  // history (↓ walks forward), like a shell. (Esc is handled globally above.)
  const onNavKey = (e: React.KeyboardEvent): boolean => {
    if (e.key === 'ArrowUp') {
      // 1) Recall the pending (queued) message for editing.
      if (!text && histIdx === -1 && activeConv?.queued) {
        e.preventDefault()
        const q = useAiStore.getState().takeQueued(activeConv.id)
        if (q) setText(q)
        return true
      }
      // 2) Walk back through previously sent messages.
      if (!barHistory.length) return false
      e.preventDefault()
      if (histIdx === -1) draftRef.current = text
      const idx = histIdx === -1 ? barHistory.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(idx)
      setText(barHistory[idx])
      return true
    }
    if (e.key === 'ArrowDown' && histIdx !== -1) {
      e.preventDefault()
      const idx = histIdx + 1
      if (idx >= barHistory.length) {
        setHistIdx(-1)
        setText(draftRef.current)
      } else {
        setHistIdx(idx)
        setText(barHistory[idx])
      }
      return true
    }
    return false
  }

  const cycleMode = (): void => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]
    useUiStore.getState().set({ barMode: next })
    setTimeout(() => ref.current?.focus(), 0)
  }

  const openLaunchPad = (): void => useUiStore.getState().set({ launchPadOpen: true })

  const toggleBypass = (): void => {
    const next = !bypass
    void useSettingsStore.getState().update({ ai: { claudeBypass: next } as never })
    if (activeConv?.engine === 'claude-code') window.zarya.claudeCode.setBypass(activeConv.id, next)
    useUiStore.getState().toast(
      next ? 'Без подтверждений — агент выполняет всё сам' : 'Подтверждения инструментов включены',
      next ? 'error' : 'success'
    )
  }

  const isShell = mode === 'shell'
  const isClaude = mode === 'claude-code'

  if (question) {
    return (
      <div className="zy-agentbar">
        <ClaudeQuestionBar
          conv={activeConv!}
          toolId={question.id}
          questions={(question.questions ?? []) as ClaudeCliQuestion[]}
        />
      </div>
    )
  }

  return (
    <div className="zy-agentbar">
      <button
        className="zy-agentbar-fuel"
        title={
          isClaude
            ? `Топливо: подписка ${claudeStatus.usage?.subscriptionType ?? 'Claude'}. 5ч и 7дн окна лимита · модель ${claudeStatus.model ?? '—'}${claudeStatus.effort ? ` · тяга ${claudeStatus.effort}` : ''}`
            : 'Топливо · пусковой комплекс'
        }
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
        {isClaude && claudeStatus.usage?.fiveHourPct != null ? (
          <>
            <FuelGauge used={claudeStatus.usage.fiveHourPct} />
            <span className="zy-agentbar-fuel-val">
              5ч {Math.round(claudeStatus.usage.fiveHourPct)}%
              {claudeStatus.usage.fiveHourResetsAt
                ? ` · сброс через ${resetLabel(claudeStatus.usage.fiveHourResetsAt)}`
                : ''}
              {claudeStatus.usage.sevenDayPct != null
                ? ` · 7дн ${Math.round(claudeStatus.usage.sevenDayPct)}%`
                : ''}
            </span>
          </>
        ) : (
          <span className="zy-agentbar-fuel-val">
            {isClaude ? `подписка ${claudeStatus.usage?.subscriptionType ?? 'Max'} · борт заправлен` : '∞ без лимита · локальный борт'}
          </span>
        )}
        <span className="zy-agentbar-fuel-spacer" />
        {isClaude && (claudeStatus.model || claudeStatus.effort || ultracode) && (
          <span className="zy-agentbar-fuel-model">
            {claudeStatus.model ? prettyModel(claudeStatus.model) : ''}
            {ultracode ? ' · ⚡ULTRACODE' : claudeStatus.effort ? ` · ${claudeStatus.effort.toUpperCase()}` : ''}
          </span>
        )}
        <span className="zy-agentbar-fuel-pult">пульт ▴</span>
      </button>

      <div className="zy-agentbar-row">
        <button
          className={`zy-agentbar-mode zy-agentbar-mode--${mode}`}
          title={
            isShell
              ? 'Режим: Терминал — Enter выполнит команду. Нажми, чтобы говорить с агентом'
              : isClaude
                ? 'Режим: Claude Code (нативно, подписка Max) — Enter отправит запрос. Нажми — сменить режим'
                : 'Режим: Zarya (свой ключ) — Enter отправит запрос. Нажми — сменить режим'
          }
          onClick={cycleMode}
        >
          <Icon name={isShell ? 'terminal' : 'bolt'} size={13} />
          {MODE_LABEL[mode]}
        </button>
        {isClaude && (
          <button
            className={`zy-agentbar-bypass${bypass ? ' zy-agentbar-bypass--on' : ''}`}
            title={
              bypass
                ? '⚠ БЕЗ СПРОСА — агент выполняет все инструменты сам, без подтверждений (кроме вопросов AskUserQuestion). Клик: вернуть подтверждения'
                : 'Агент спрашивает подтверждение перед инструментами. Клик: отключить подтверждения (выполнять без спроса)'
            }
            onClick={toggleBypass}
          >
            <span className="zy-agentbar-bypass-dot" />
            {bypass ? '⚠ БЕЗ СПРОСА' : 'СПРАШИВАЕТ'}
          </button>
        )}
        <input
          ref={ref}
          className="zy-agentbar-input"
          placeholder={
            busyConv && mode !== 'shell'
              ? 'Агент работает — Enter поставит в очередь · Esc прервать · ↑ править'
              : MODE_PLACEHOLDER[mode]
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // The user edited a recalled item → leave history-browse mode.
            if (histIdx !== -1 && e.target.value !== barHistory[histIdx]) setHistIdx(-1)
          }}
          onKeyDown={(e) => {
            if (onNavKey(e)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              doAction()
            } else if ((e.ctrlKey || e.metaKey) && /^[iшI]$/i.test(e.key)) {
              // Ctrl+I → jump into Claude Code mode (and send if there's text).
              e.preventDefault()
              if (mode !== 'claude-code') useUiStore.getState().set({ barMode: 'claude-code' })
              if (text.trim()) askAgent('claude-code')
            }
          }}
        />
        {mode === 'zarya' && (
          <>
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
          </>
        )}
        <button
          className="zy-agentbar-send"
          title={isShell ? 'Выполнить команду (Enter)' : 'Отправить агенту (Enter)'}
          onClick={doAction}
        >
          <Icon name="send" size={16} />
        </button>
      </div>
    </div>
  )
}
