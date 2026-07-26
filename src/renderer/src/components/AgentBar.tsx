import { useEffect, useRef, useState } from 'react'
import type { AgentEngine, AgentUsage, AiEffort, ClaudeCliQuestion } from '@shared/types'
import { EFFORT_TUNING } from '@shared/defaults'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { nextGate } from '@/features/ai/gates'
import { Icon, EngineGlyph } from './Icon'
import { PixelIcon } from './PixelIcon'
import { isSilent, startRecording, type Recording } from '@/features/voice/dictation'
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

type BarMode = 'shell' | 'zarya' | AgentEngine
const MODE_LABEL: Record<BarMode, string> = {
  shell: 'ТЕРМИНАЛ',
  zarya: 'ZARYA',
  'claude-code': 'CLAUDE CODE',
  codex: 'CODEX',
  gemini: 'GEMINI',
  kimi: 'KIMI',
  qwen: 'QWEN'
}
const MODE_PLACEHOLDER: Record<BarMode, string> = {
  shell: 'Команда терминала…  (Enter — выполнить)',
  zarya: 'Спросить агента Zarya…  (Enter)',
  'claude-code': 'Спросить Claude Code…  (Enter, нативно, подписка Max)',
  codex: 'Спросить Codex…  (Enter, нативно)',
  gemini: 'Спросить Gemini…  (Enter, нативно)',
  kimi: 'Спросить Kimi…  (Enter, нативно)',
  qwen: 'Спросить Qwen…  (Enter, нативно)'
}
/** The manual chip cycle: Терминал ⇄ each detected native engine. «Zarya» is a
 *  niche entered only by auto-follow, so it stays out of the cycle. */
function modeCycle(engines: string[]): BarMode[] {
  return ['shell', ...(engines as AgentEngine[])]
}

// Commands that take over the terminal (TUI / raw input) → auto-switch to the
// live «Терминал» view so arrows/prompts work.
const INTERACTIVE_CMDS = new Set([
  'claude',
  'gemini',
  'codex',
  'aider',
  'cursor-agent',
  'ollama',
  'vim',
  'nvim',
  'vi',
  'nano',
  'emacs',
  'less',
  'more',
  'top',
  'htop',
  'btop',
  'ssh',
  'tmux',
  'screen',
  'fzf',
  'lazygit',
  'lazydocker',
  'python',
  'python3',
  'node',
  'irb',
  'psql',
  'mysql',
  'sqlite3',
  'redis-cli'
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
  if (mins <= 1) return 'минуту'
  if (mins < 60) return `${mins} мин`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  // The weekly window resets days out, and «через 96 ч» is not how anyone reads
  // that — count in days once it stops being an afternoon away.
  if (h >= 24) {
    const d = Math.round(h / 24)
    const tail = d % 10 === 1 && d % 100 !== 11 ? 'день' : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 10 || d % 100 >= 20) ? 'дня' : 'дней'
    return `${d} ${tail}`
  }
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

/** Compact token count for the context readout tooltip (45 231 → "45K"). */
function fmtTokens(n?: number): string {
  if (n == null) return '—'
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
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

/** One readout in the usage panel: label, its own bar, value and reset time. */
function UsageRow({
  label,
  pct,
  note
}: {
  label: string
  pct: number
  note?: string
}): React.JSX.Element {
  return (
    <div className="zy-usage-row">
      <span className="zy-usage-label">{label}</span>
      <FuelGauge used={pct} />
      <span className="zy-usage-pct">{Math.round(pct)}%</span>
      {note ? <span className="zy-usage-note">{note}</span> : null}
    </div>
  )
}

/**
 * The limits, one per line — the shape the Claude app uses, and the reason the
 * bar itself carries a single figure. Four readings queued on one line («5ч 14%
 * · сброс через 3 ч 2 мин · 7дн 18% · контекст 32%») parse as noise; stacked and
 * labelled, each is legible at a glance.
 *
 * Engines without a subscription gauge (Codex, the ACP ones) still get the
 * context row — it is universal — instead of an empty panel.
 */
function UsagePanel({
  usage,
  context,
  onClose
}: {
  usage?: AgentUsage
  context: { pct?: number; tokens?: number; window?: number }
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Deferred: the click that opened the panel is still travelling.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const rows: React.JSX.Element[] = []
  if (usage?.fiveHourPct != null)
    rows.push(
      <UsageRow
        key="5h"
        label="5 часов"
        pct={usage.fiveHourPct}
        note={usage.fiveHourResetsAt ? `сброс через ${resetLabel(usage.fiveHourResetsAt)}` : undefined}
      />
    )
  if (usage?.sevenDayPct != null)
    rows.push(
      <UsageRow
        key="7d"
        label="7 дней"
        pct={usage.sevenDayPct}
        note={usage.sevenDayResetsAt ? `сброс через ${resetLabel(usage.sevenDayResetsAt)}` : undefined}
      />
    )
  if (context.pct != null)
    rows.push(
      <UsageRow
        key="ctx"
        label="Контекст"
        pct={context.pct}
        note={
          context.tokens != null && context.window != null
            ? `${fmtTokens(context.tokens)} из ${fmtTokens(context.window)} токенов`
            : undefined
        }
      />
    )

  return (
    <div className="zy-usage-panel" ref={ref}>
      <div className="zy-usage-head">
        <span>РАСХОД</span>
        {usage?.subscriptionType ? <span className="zy-usage-sub">{usage.subscriptionType}</span> : null}
      </div>
      {rows.length ? (
        rows
      ) : (
        <div className="zy-usage-empty">
          Данных пока нет — появятся после первого ответа агента.
        </div>
      )}
    </div>
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
  const agentContext = useUiStore((s) => s.agentContext)
  const ultracode = useUiStore((s) => s.ultracode)
  const bypass = useSettingsStore((s) => s.settings.ai.claudeBypass)
  const autoApprove = useSettingsStore((s) => s.settings.ai.autoApprove)
  const agentCaps = useUiStore((s) => s.agentCaps)
  // The native engine the bar currently targets (null in shell/zarya) + its
  // capabilities — the UI gates controls on these, not on `=== 'claude-code'`.
  const activeEngine: AgentEngine | null = mode !== 'shell' && mode !== 'zarya' ? mode : null
  const caps = activeEngine ? agentCaps[activeEngine] : null
  const [text, setText] = useState('')
  const [usageOpen, setUsageOpen] = useState(false)
  const [voice, setVoice] = useState<'idle' | 'rec' | 'work' | 'load'>('idle')
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [voiceNote, setVoiceNote] = useState('')
  const recRef = useRef<Recording | null>(null)
  /** Cancelled while getUserMedia was still resolving. */
  const voiceCancelled = useRef(false)
  /** Recording started by holding the key — silence must not end it early. */
  const pttRef = useRef(false)
  // -1 = not browsing history; otherwise index into barHistory.
  const [histIdx, setHistIdx] = useState(-1)
  const draftRef = useRef('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const activeSessionId = useSessionsStore((s) => s.activeSessionId())
  // The conversation belongs to the active terminal — each terminal its own chat.
  const activeConv = useAiStore((s) => convForSession(s, activeSessionId))

  // Global keys (window-active, focus-independent): Esc interrupts the working
  // agent; Enter/Esc approve/deny a pending tool. Skipped while an overlay owns
  // Esc, in raw terminal mode, or during a pending choice (the choice bar owns it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      // SECURITY: only a BARE Enter approves a gate. Once the input became a
      // textarea, Shift/Ctrl+Enter meant «new line» — but this global listener
      // still saw a plain Enter with the field empty and silently ran the
      // pending tool. Approving something because the user asked for a line
      // break is exactly the blind «yes» the gate exists to prevent.
      if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) return
      // Esc during dictation cancels the take. The tooltip promised this and
      // nothing implemented it, so Esc fell through to interrupting the agent.
      if (e.key === 'Escape' && recRef.current) {
        e.preventDefault()
        voiceCancelled.current = true
        recRef.current.cancel()
        recRef.current = null
        setVoice('idle')
        setVoiceLevel(0)
        setVoiceNote('')
        return
      }
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
      const pendingRun = nextGate(conv)
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
    const want: BarMode = activeConv.engine !== 'builtin' ? activeConv.engine : 'zarya'
    if (useUiStore.getState().barMode !== want) useUiStore.getState().set({ barMode: want })
  }, [activeConv?.id, activeConv?.engine, activeConv?.messages.length, activeConv?.streaming])

  // A pending AskUserQuestion on the active native-agent conversation replaces
  // the whole input area with the native choice selector.
  const question =
    activeConv && activeConv.engine !== 'builtin'
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

  const askAgent = (agentEngine: 'builtin' | AgentEngine): void => {
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
  const modeEngine: 'builtin' | AgentEngine | null =
    activeEngine ?? (mode === 'zarya' ? 'builtin' : null)
  const busyConv =
    !!modeEngine &&
    activeConv?.engine === modeEngine &&
    (activeConv.streaming || activeConv.pendingTools.some((t) => t.settled))

  const doAction = (): void => {
    if (mode === 'shell') {
      runShell()
      return
    }
    const engine: 'builtin' | AgentEngine = activeEngine ?? 'builtin'
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
    // With a multi-line field the arrows belong to the caret first: only step
    // through history when the text is a single line, or the caret sits at the
    // very edge of a multi-line one.
    const el = e.currentTarget as HTMLTextAreaElement
    const caret = el.selectionStart ?? 0
    const multiline = text.includes('\n')
    if (multiline) {
      if (e.key === 'ArrowUp' && caret > 0) return false
      if (e.key === 'ArrowDown' && caret < text.length) return false
    }
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
    // Don't switch away from a busy/gated engine: its permission or question
    // would land on a now-hidden conversation and hang with no UI to resolve it.
    if (busyConv) {
      useUiStore
        .getState()
        .toast('Движок занят — дождитесь ответа или Esc, потом переключайтесь', 'info')
      return
    }
    const order = modeCycle(Object.keys(agentCaps))
    const next = order[(order.indexOf(mode) + 1) % order.length] ?? 'shell'
    useUiStore.getState().set({ barMode: next })
    setTimeout(() => ref.current?.focus(), 0)
  }

  const openLaunchPad = (): void => useUiStore.getState().set({ launchPadOpen: true })

  const toggleBypass = (): void => {
    const next = !bypass
    void useSettingsStore.getState().update({ ai: { claudeBypass: next } as never })
    if (activeConv && activeConv.engine !== 'builtin')
      window.zarya.agent.setBypass(activeConv.engine, activeConv.id, next)
    useUiStore
      .getState()
      .toast(
        next
          ? 'Без подтверждений — агент выполняет всё сам'
          : 'Подтверждения инструментов включены',
        next ? 'error' : 'success'
      )
  }

  /**
   * Dictation. The recognized text is INSERTED, never sent: recognition makes
   * mistakes and this bar runs commands, so the last read belongs to the human.
   * The mic opens on an explicit action and closes the moment the take ends.
   */
  const finishVoice = async (): Promise<void> => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    setVoiceLevel(0)
    const { samples, sampleRate } = await rec.stop()
    if (isSilent(samples)) {
      setVoice('idle')
      setVoiceNote('')
      return
    }
    setVoice('work')
    const res = await window.zarya.stt.transcribe(samples, sampleRate)
    setVoice('idle')
    if (!res.ok) {
      setVoiceNote(res.error ?? 'не распозналось')
      useUiStore.getState().toast(res.error ?? 'Распознавание не удалось', 'error')
      return
    }
    setVoiceNote('')
    const said = (res.text ?? '').trim()
    if (!said) {
      useUiStore.getState().toast('Ничего не разобрал', 'error')
      return
    }
    setText((t) => (t ? `${t} ${said}` : said))
    setTimeout(() => ref.current?.focus(), 0)
  }

  const startVoice = async (): Promise<void> => {
    if (recRef.current || voice !== 'idle') return
    // Claim the slot BEFORE the first await. Two entry points can fire almost
    // together (button click and the push-to-talk key), and both would pass the
    // guard above while awaiting — opening two microphones and orphaning the
    // first Recording with the device still live.
    setVoice('load')
    const state = await window.zarya.stt.state()
    if (!state.modelReady) {
      // First run downloads ~225 MB — say so instead of appearing frozen.
      setVoiceNote('загружаю модель…')
      const r = await window.zarya.stt.ensureModel()
      setVoiceNote('')
      if (!r?.ok) {
        setVoice('idle')
        useUiStore.getState().toast(r?.error ?? 'Не удалось загрузить модель', 'error')
        return
      }
    }
    try {
      const rec = await startRecording()
      // Someone cancelled while getUserMedia was resolving — release the device
      // instead of leaving it open behind a state that says «idle».
      if (voiceCancelled.current) {
        rec.cancel()
        voiceCancelled.current = false
        setVoice('idle')
        return
      }
      recRef.current = rec
      setVoice('rec')
    } catch (e) {
      useUiStore
        .getState()
        .toast(e instanceof Error ? e.message : 'Микрофон недоступен', 'error')
      setVoice('idle')
    }
  }

  const cancelVoice = (): void => {
    voiceCancelled.current = true
    recRef.current?.cancel()
    recRef.current = null
    setVoice('idle')
    setVoiceLevel(0)
    setVoiceNote('')
  }

  // The microphone must close itself. The bar unmounts WITHOUT the user doing
  // anything about dictation — Ctrl+` or a TUI taking over the terminal drops
  // it — and an abandoned Recording keeps the device open for the life of the
  // process, with no button left on screen to stop it. Empty deps on purpose:
  // this must run only on unmount, never when `voice` changes.
  useEffect(
    () => () => {
      recRef.current?.cancel()
      recRef.current = null
    },
    []
  )

  // Meter + silence auto-stop for the click-to-toggle mode. Not a neural VAD:
  // it simply ends the take once speech has been heard and then stops.
  useEffect(() => {
    if (voice !== 'rec') return
    let heard = false
    let quietSince = 0
    const timer = window.setInterval(() => {
      const lvl = recRef.current?.level() ?? 0
      setVoiceLevel(lvl)
      if (lvl > 0.12) {
        heard = true
        quietSince = 0
      } else if (heard && !pttRef.current) {
        quietSince = quietSince || Date.now()
        if (Date.now() - quietSince > 1500) void finishVoice()
      }
    }, 100)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice])

  // Grow the field with its content instead of scrolling a one-line box —
  // capped so a pasted wall of text can't eat the window.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  // The first dictation downloads ~225 MB. Silence here would read as a frozen
  // button, so the bar reports progress for as long as it runs.
  useEffect(() => {
    return window.zarya.stt.onProgress((p) => {
      if (!p) {
        setVoiceNote('')
        return
      }
      const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0
      setVoiceNote(`модель распознавания… ${pct}%`)
    })
  }, [])

  // Push-to-talk: hold the key, speak, release. Ignored while typing in a field.
  useEffect(() => {
    const isHotkey = (e: KeyboardEvent): boolean => e.ctrlKey && e.shiftKey && e.code === 'Space'
    const down = (e: KeyboardEvent): void => {
      if (!isHotkey(e) || e.repeat) return
      e.preventDefault()
      pttRef.current = true
      void startVoice()
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      pttRef.current = false
      if (recRef.current) void finishVoice()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice])

  const toggleAutoApprove = (): void => {
    const next = !autoApprove
    void useSettingsStore.getState().update({ ai: { autoApprove: next } as never })
    useUiStore
      .getState()
      .toast(
        next
          ? 'Без подтверждений — борт сам выполняет команды в терминале'
          : 'Подтверждение команд включено',
        next ? 'error' : 'success'
      )
  }


  const isShell = mode === 'shell'
  const isAgent = activeEngine !== null // a native agent mode is selected
  // Conditional controls driven by the engine's declared capabilities, not by
  // `=== 'claude-code'`. An engine without usage/models hides those.
  const showFuel = !!caps?.usage
  const showModel = !!caps?.models

  // The headline figure is whichever window is closest to running out — that is
  // the one worth a permanent place in the bar. The others are one click away.
  const lead = ((): { short: string; label: string; pct: number } | null => {
    if (!showFuel) return null
    const u = claudeStatus.usage
    const five = u?.fiveHourPct
    const seven = u?.sevenDayPct
    if (five == null && seven == null) return null
    if (seven != null && (five == null || seven > five))
      return { short: '7дн', label: 'Недельный лимит', pct: seven }
    return { short: '5ч', label: 'Пятичасовой лимит', pct: five as number }
  })()

  // SECURITY: the chip is the one place that answers «will I be asked?», so it
  // is shown in EVERY agent mode and reads the switch that actually governs the
  // active engine — `ai.autoApprove` for the built-in Zarya agent (it used to
  // have no indicator at all, so auto-run looked identical to manual), and
  // АВТОПИЛОТ for native engines. An engine that cannot bypass (ACP: Gemini /
  // Kimi / Qwen always ask) renders the chip locked on «РУЧНОЙ» instead of an
  // inviting toggle that silently does nothing.
  //
  // `caps === undefined` means «not loaded yet», NOT «cannot bypass»: capabilities
  // arrive from one async IPC that waits on every driver's probe, and until it
  // lands a turn still goes out with `bypass: ai.claudeBypass` (dispatchAgent).
  // Collapsing unknown into false made the chip claim «always asks» while the
  // driver was auto-allowing — the exact lie it exists to prevent. Lock it only
  // on an explicit bypass:false.
  const isBuiltinMode = mode === 'zarya'
  const canToggleGate = isBuiltinMode || caps?.bypass !== false
  const gateOff = isBuiltinMode ? autoApprove : bypass && caps?.bypass !== false
  const gateTitle = isBuiltinMode
    ? gateOff
      ? '⚠ АВТОПИЛОТ — борт сам выполняет команды в терминале, без подтверждения. Клик: вернуть ручное управление'
      : 'Ручное управление — борт спрашивает подтверждение перед каждой командой. Клик: включить автопилот (выполнять без подтверждений)'
    : !canToggleGate
      ? `Ручное управление — ${MODE_LABEL[mode]} всегда спрашивает подтверждение перед инструментом; автопилот для этого борта не поддерживается`
      : gateOff
        ? '⚠ АВТОПИЛОТ — борт выполняет все инструменты сам, без подтверждений (кроме вопросов AskUserQuestion). Клик: вернуть ручное управление'
        : 'Ручное управление — борт спрашивает подтверждение перед инструментами. Клик: включить автопилот (выполнять без подтверждений)'

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
      {usageOpen && (
        <UsagePanel
          usage={showFuel ? claudeStatus.usage : undefined}
          context={agentContext}
          onClose={() => setUsageOpen(false)}
        />
      )}
      {/* One headline figure, not four readings queued on a single line. The rest
          opens on demand — see UsagePanel. */}
      <div className="zy-agentbar-fuel">
        <button
          className="zy-agentbar-fuel-main"
          title={
            lead
              ? `${lead.label}: израсходовано ${Math.round(lead.pct)}%. Нажми — все лимиты`
              : 'Лимиты и контекст беседы'
          }
          aria-expanded={usageOpen}
          onClick={() => setUsageOpen((v) => !v)}
        >
          <span className="zy-agentbar-fuel-icon">
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              shapeRendering="crispEdges"
              fill="var(--accent-2)"
            >
              <rect x="4" y="2" width="6" height="2" />
              <rect x="4" y="4" width="6" height="9" />
              <rect x="10" y="5" width="3" height="2" />
              <rect x="12" y="6" width="1" height="4" />
            </svg>
          </span>
          {lead ? (
            <>
              <FuelGauge used={lead.pct} />
              <span className="zy-agentbar-fuel-val">
                {lead.short} {Math.round(lead.pct)}%
              </span>
            </>
          ) : (
            <span className="zy-agentbar-fuel-val">
              {showFuel ? 'борт заправлен' : '∞ без лимита · локальный борт'}
            </span>
          )}
          <Icon name={usageOpen ? 'chevron-down' : 'chevron-up'} size={10} />
        </button>
        <span className="zy-agentbar-fuel-spacer" />
        {showModel && (claudeStatus.model || claudeStatus.effort || ultracode) && (
          <button className="zy-agentbar-fuel-model" onClick={openLaunchPad} title="Двигатель и тяга">
            {claudeStatus.model ? prettyModel(claudeStatus.model) : ''}
            {ultracode
              ? ' · ⚡ULTRACODE'
              : claudeStatus.effort
                ? ` · ${claudeStatus.effort.toUpperCase()}`
                : ''}
          </button>
        )}
        <button className="zy-agentbar-fuel-pult" onClick={openLaunchPad} title="Пусковой комплекс">
          пульт ▴
        </button>
      </div>

      <div className="zy-agentbar-row">
        {/* Icon-only chips: the engine and the gate are permanent fixtures, and
            spelling them out in full caps ate the bar. The label lives in the
            tooltip; the gate additionally keeps its colour, because «will I be
            asked?» must stay readable without hovering. */}
        <button
          className={`zy-agentbar-mode zy-agentbar-mode--icon zy-agentbar-mode--${mode}`}
          title={
            isShell
              ? 'Режим: Терминал — Enter выполнит команду. Нажми, чтобы говорить с агентом'
              : isAgent
                ? `Режим: ${MODE_LABEL[mode]} (нативно) — Enter отправит запрос. Нажми — сменить режим`
                : 'Режим: Zarya (свой ключ) — Enter отправит запрос. Нажми — сменить режим'
          }
          aria-label={`Режим: ${MODE_LABEL[mode]}`}
          onClick={cycleMode}
        >
          <EngineGlyph engine={mode} size={14} />
        </button>
        {!isShell && (
          <button
            className={`zy-agentbar-bypass zy-agentbar-bypass--icon${
              gateOff ? ' zy-agentbar-bypass--on' : ''
            }${canToggleGate ? '' : ' zy-agentbar-bypass--locked'}`}
            title={gateTitle}
            aria-label={gateOff ? 'Автопилот включён' : 'Ручное управление'}
            disabled={!canToggleGate}
            onClick={
              canToggleGate ? (isBuiltinMode ? toggleAutoApprove : toggleBypass) : undefined
            }
          >
            {gateOff ? <Icon name="bolt" size={13} /> : <PixelIcon name="lock" />}
          </button>
        )}
        {/* Dictation. While recording the button IS the indicator — the mic is
            open, and that must be visible without hunting for a status line. */}
        <button
          className={`zy-agentbar-mic${voice === 'rec' ? ' zy-agentbar-mic--rec' : ''}${
            voice === 'work' || voice === 'load' ? ' zy-agentbar-mic--busy' : ''
          }`}
          title={
            voice === 'rec'
              ? 'Идёт запись — нажми, чтобы закончить (Esc — отменить)'
              : voice === 'load'
                ? 'Загружается модель распознавания'
                : voice === 'work'
                  ? 'Распознаю…'
                  : 'Диктовка: нажми или удерживай Ctrl+Shift+Space. Текст попадёт в строку, отправишь сам'
          }
          aria-label="Диктовка"
          onClick={() => (voice === 'rec' ? void finishVoice() : void startVoice())}
        >
          {voice === 'rec' ? (
            <span className="zy-mic-meter" aria-hidden>
              {Array.from({ length: 4 }, (_, i) => (
                <span
                  key={i}
                  className={`zy-mic-cell${voiceLevel > (i + 1) / 5 ? ' zy-mic-cell--on' : ''}`}
                />
              ))}
            </span>
          ) : (
            <PixelIcon name="mic" />
          )}
        </button>
        {voiceNote && <span className="zy-agentbar-voicenote">{voiceNote}</span>}
        <textarea
          ref={ref}
          className="zy-agentbar-input"
          rows={1}
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
            // Shift+Enter / Ctrl+Enter insert a line break — a multi-line prompt
            // is normal for an agent, and a plain <input> could never do it.
            if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              const el = e.currentTarget
              const at = el.selectionStart ?? text.length
              const to = el.selectionEnd ?? at
              const next = `${text.slice(0, at)}\n${text.slice(to)}`
              setText(next)
              // Put the caret after the break, once React has re-rendered.
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = at + 1
              })
              return
            }
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
