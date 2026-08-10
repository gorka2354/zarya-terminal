import { memo, useEffect, useRef, useState, useMemo } from 'react'
import type { AgentEngine, AgentUsage, AiEffort, ClaudeCliQuestion } from '@shared/types'
import { EFFORT_TUNING } from '@shared/defaults'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { paneDraft, setPaneDraft } from '@/state/paneDrafts'
import { paneHistory, pushPaneHistory } from '@/state/paneHistory'
import { currentLang, t } from '@/lib/i18n'
import { onBus } from '@/lib/bus'
import { formatCost } from '@shared/cost'
import {
  agentStatusOf,
  barModeOf,
  setBarModeOf,
  setPaneBarMode,
  setRaw,
  useUiStore
} from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { interruptPane, paneIsRunning } from '@/terminal/paneSignal'
import { quotePath } from '@/terminal/panePaths'
import { nextGate } from '@/features/ai/gates'
import { registerPaneKeys } from '@/features/ai/keyRouter'
import { fileToAttachment, imageFilesFrom } from '@/features/ai/imageAttach'
import { canAcceptMore, type ImageAttachment } from '@shared/images'
import { Icon, EngineGlyph } from './Icon'
import { PixelIcon } from './PixelIcon'
import { isSilent, startRecording, type Recording } from '@/features/voice/dictation'
import { claimMic, releaseMic, useMicBusyElsewhere } from '@/features/voice/micLock'
import {
  labelsHidden,
  listMics,
  micName,
  onDeviceChange,
  pickDeviceId,
  resolveMic,
  revealMicLabels,
  usableMics,
  type MicDevice
} from '@/features/voice/devices'
import { useContextMenu, type MenuItem } from './ContextMenu'
import { ClaudeQuestionBar } from './ClaudeQuestionBar'
import { launchClaudeNative } from './AiCliLauncher'
import './agentbar.css'
import { applyCommand, cleanCommands, commandQuery, matchCommands, type AgentCommand } from '@shared/agentCommands'
import { CommandList } from './CommandList'
import { ExtrasBar } from './ExtrasBar'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']
/** Стабильная пустая ссылка для селектора вложений — см. AgentBar. */
const NO_IMAGES: ImageAttachment[] = []

/**
 * Про какие пропавшие микрофоны уже сказали в этом запуске (ключ — сохранённый
 * deviceId). На уровне модуля, а не в ref: бар перемонтируется (Ctrl+`, TUI), и
 * счётчик в ref обнулялся бы вместе с ним. Запись снимается, когда устройство
 * находится снова.
 */
const warnedMissingMics = new Set<string>()

type BarMode = 'shell' | 'zarya' | AgentEngine
const MODE_LABEL: Record<BarMode, string> = {
  shell: 'shell',
  zarya: 'ZARYA',
  'claude-code': 'CLAUDE CODE',
  codex: 'CODEX',
  gemini: 'GEMINI',
  kimi: 'KIMI',
  qwen: 'QWEN'
}
/** Подпись режима: у оболочки она переводится, у движков это имена. */
function modeLabel(mode: BarMode): string {
  return mode === 'shell' ? t('bar.modeTerminal') : MODE_LABEL[mode]
}
/** Подсказка в строке ввода — по режиму. */
function modePlaceholder(mode: BarMode): string {
  const byMode: Record<BarMode, string> = {
    shell: 'bar.placeholderShell',
    zarya: 'bar.placeholderZarya',
    'claude-code': 'bar.placeholderClaude',
    codex: 'bar.placeholderCodex',
    gemini: 'bar.placeholderGemini',
    kimi: 'bar.placeholderKimi',
    qwen: 'bar.placeholderQwen'
  }
  return t(byMode[mode])
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
  if (mins <= 1) return t('time.aMinute')
  if (mins < 60) return t('time.mins', { n: mins })
  const h = Math.floor(mins / 60)
  const m = mins % 60
  // The weekly window resets days out, and «через 96 ч» is not how anyone reads
  // that — count in days once it stops being an afternoon away.
  if (h >= 24) {
    const d = Math.round(h / 24)
    // Русская плюрализация живёт здесь: в английском формы две, в русском три,
    // и через один ключ это не выражается.
    const tail =
      currentLang() === 'en'
        ? d === 1
          ? t('time.dayOne')
          : t('time.dayMany')
        : d % 10 === 1 && d % 100 !== 11
          ? t('time.dayOne')
          : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 10 || d % 100 >= 20)
            ? t('time.dayFew')
            : t('time.dayMany')
    return `${d} ${tail}`
  }
  return m ? `${h} ${t('time.h')} ${m} ${t('time.min')}` : `${h} ${t('time.h')}`
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
export function FuelGauge({ used }: { used: number }): React.JSX.Element {
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
export function UsagePanel({
  usage,
  context,
  onClose,
  anchor
}: {
  usage?: AgentUsage
  context: { pct?: number; tokens?: number; window?: number }
  onClose: () => void
  /**
   * Кнопка, которой панель открывают. Нажатие по ней не считается «щелчком
   * снаружи»: панель закрывается по mousedown, а кнопка переключается по click,
   * и без этой оговорки повторное нажатие закрывало панель и тут же открывало
   * заново — со стороны выглядело как «панель не закрывается, только мигает».
   */
  anchor?: HTMLElement | null
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      // Переключение оставлено обработчику кнопки: он единственный знает, что
      // значит «нажали ещё раз».
      if (anchor?.contains(t)) return
      onClose()
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
  }, [onClose, anchor])

  const rows: React.JSX.Element[] = []
  if (usage?.fiveHourPct != null)
    rows.push(
      <UsageRow
        key="5h"
        label={t('usage.fiveHours')}
        pct={usage.fiveHourPct}
        note={
          usage.fiveHourResetsAt ? t('usage.resetsIn', { time: resetLabel(usage.fiveHourResetsAt) }) : undefined
        }
      />
    )
  if (usage?.sevenDayPct != null)
    rows.push(
      <UsageRow
        key="7d"
        label={t('usage.sevenDays')}
        pct={usage.sevenDayPct}
        note={
          usage.sevenDayResetsAt ? t('usage.resetsIn', { time: resetLabel(usage.sevenDayResetsAt) }) : undefined
        }
      />
    )
  if (context.pct != null)
    rows.push(
      <UsageRow
        key="ctx"
        label={t('usage.context')}
        pct={context.pct}
        note={
          context.tokens != null && context.window != null
            ? t('usage.tokensOf', { used: fmtTokens(context.tokens), total: fmtTokens(context.window) })
            : undefined
        }
      />
    )

  return (
    <div className="zy-usage-panel" ref={ref}>
      <div className="zy-usage-head">
        <span>{t('usage.title')}</span>
        {usage?.subscriptionType ? (
          <span className="zy-usage-sub">{usage.subscriptionType}</span>
        ) : null}
      </div>
      {rows.length ? (
        rows
      ) : (
        <div className="zy-usage-empty">
          {t('usage.empty')}
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
export const AgentBar = memo(function AgentBar({
  paneSessionId
}: { paneSessionId?: string } = {}): React.JSX.Element {
  const model = useSettingsStore((s) => s.settings.ai.model)
  const effort = useSettingsStore((s) => s.settings.ai.effort)
  const effortIdx = EFFORTS.indexOf(effort)
  // Режим строки — СВОЙ у каждой панели. Общее значение окна читалось напрямую,
  // и агент, начавший ход в соседней панели, авто-переключал чип ЗДЕСЬ: Enter
  // уводил набранную команду терминала в модель вместо оболочки.
  const mode = useUiStore((s) => barModeOf(s, paneSessionId))
  const claudeStatus = useUiStore((s) => s.claudeStatus)
  const agentContext = useUiStore((s) => s.agentContext)
  const ultracode = useUiStore((s) => s.ultracode)
  const autoApprove = useSettingsStore((s) => s.settings.ai.autoApprove)
  const agentCaps = useUiStore((s) => s.agentCaps)
  // The native engine the bar currently targets (null in shell/zarya) + its
  // capabilities — the UI gates controls on these, not on `=== 'claude-code'`.
  const activeEngine: AgentEngine | null = mode !== 'shell' && mode !== 'zarya' ? mode : null
  const caps = activeEngine ? agentCaps[activeEngine] : null
  // Начальное значение — черновик своей панели: строка могла уйти с экрана
  // (сырой режим, TUI) и вернуться, и набранное обязано вернуться вместе с ней.
  const [text, setText] = useState(() => paneDraft(paneSessionId))
  const [usageOpen, setUsageOpen] = useState(false)
  /** Кнопка топливной строки — она же открывашка панели расхода. */
  const fuelBtnRef = useRef<HTMLButtonElement>(null)
  const [voice, setVoice] = useState<'idle' | 'rec' | 'work' | 'load'>('idle')
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [voiceNote, setVoiceNote] = useState('')
  const recRef = useRef<Recording | null>(null)
  /** Cancelled while getUserMedia was still resolving. */
  const voiceCancelled = useRef(false)
  /** Бар ещё на экране. Ложь = запись, открывшуюся после ухода, надо закрыть. */
  const aliveRef = useRef(true)
  const voiceCfg = useSettingsStore((s) => s.settings.voice)
  const [mics, setMics] = useState<MicDevice[]>([])
  const { menu: micMenu, open: openMicMenu } = useContextMenu()
  /** Recording started by holding the key — silence must not end it early. */
  const pttRef = useRef(false)
  // -1 = not browsing history; otherwise index into barHistory.
  const [histIdx, setHistIdx] = useState(-1)
  const [dragOver, setDragOver] = useState(false)
  const draftRef = useRef('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Своя панель, а не «какая сейчас активная». Спрашивать про активную — это тот
  // самый разрыв, из-за которого можно печатать в одну панель, а Enter уйдёт в
  // другую. Без параметра ведём себя как раньше: одна строка на окно.
  const storeActive = useSessionsStore((s) => s.activeSessionId())
  const activeSessionId = paneSessionId ?? storeActive
  /** Вернуть курсор в поле и поставить его в конец — после возврата текста из очереди или отмены. */
  const focusInputEnd = (): void => {
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    })
  }
  // The conversation belongs to the active terminal — each terminal its own chat.
  /*
   * Модель и усилие — СВОЕЙ панели.
   *
   * Топливо остаётся общим: лимит подписки один на аккаунт, сколько бы панелей
   * ни работало. А модель и усилие у каждой свои, и общее значение показывало
   * ту, чей ход закончился последним: панель на Opus подписывалась Sonnet, если
   * в соседней только что отработал он.
   *
   * Читаем ПОСЛЕ того, как известна панель: первая версия стояла выше по файлу
   * и валила окно на старте («Cannot access before initialization») — панелей
   * не рисовалось вовсе.
   */
  const paneStatus = useUiStore((s) => agentStatusOf(s, activeSessionId))
  const activeConv = useAiStore((s) => convForSession(s, activeSessionId))
  /*
   * Стоимость разговора и то, чем она является.
   *
   * `subscriptionType` есть — человек на подписке, и сумма расчётная: тарифы
   * API, по которым ничего не списывается. Нет — работает по своему ключу, и
   * это счёт. Одну и ту же цифру эти два случая делают противоположной по
   * смыслу, поэтому подпись выбирается здесь, а не «где-нибудь потом».
   */
  const costLabel = formatCost(activeConv?.costUsd)
  const onPlan = !!claudeStatus.usage?.subscriptionType
  // АВТОПИЛОТ показывается по СВОЕЙ беседе: общий переключатель с несколькими
  // панелями врал бы о том, спросят ли вас.
  // Хук вызывается всегда и безусловно: под условием React рвёт порядок хуков,
  // компонент падает — и строки ввода не остаётся вовсе.
  const paneBypass = useAiStore((s) =>
    activeSessionId ? !!s.bypassBySession[activeSessionId] : false
  )
  const bypass = activeConv ? !!activeConv.bypass : paneBypass
  // «Правки без спроса» — та же схема хранения, что у автопилота и плана.
  const paneEditsAuto = useAiStore((s) =>
    activeSessionId ? !!s.editsAutoBySession[activeSessionId] : false
  )
  const editsAuto = activeConv ? !!activeConv.editsAuto : paneEditsAuto
  // Режим плана — по той же схеме, что и автопилот: решение принадлежит панели
  // и живёт до первой беседы, иначе чип был бы мёртвым до отправки.
  const panePlan = useAiStore((s) =>
    activeSessionId ? !!s.planBySession[activeSessionId] : false
  )
  const planMode = activeConv ? !!activeConv.planMode : panePlan
  // Микрофон занят другой панелью — кнопка обязана это сказать, а не молчать и
  // не начинать вторую запись.
  const micBusy = useMicBusyElsewhere(activeSessionId)
  // Что именно уедет с этим ходом — видно до отправки.
  //
  // Пустой список — ОДНА И ТА ЖЕ ссылка: `?? []` в селекторе создавал новый
  // массив на каждый рендер, zustand считал состояние изменившимся и перерисовка
  // уходила в бесконечный цикл — приложение не поднималось вовсе.
  const pendingImages = useAiStore((s) =>
    activeSessionId ? s.pendingImages[activeSessionId] : undefined
  ) ?? NO_IMAGES

  /**
   * Клавиши своей панели. Строка ввода БОЛЬШЕ НЕ СЛУШАЕТ ОКНО: она заявляет свои
   * обработчики диспетчеру (features/ai/keyRouter), и тот отдаёт нажатие ровно
   * одному адресату. Пока строка одна, поведение прежнее; когда панелей станет
   * несколько, один Enter перестанет одобрять команды сразу в нескольких.
   */
  useEffect(() => {
    const sid = activeSessionId
    if (!sid) return
    return registerPaneKeys(sid, {
      onEscape: ({ overlayOpen }) => {
        // 1. Идёт диктовка — Esc прекращает запись. Выше оверлеев: микрофон
        //    слушает прямо сейчас, что бы ни было открыто.
        if (recRef.current) {
          voiceCancelled.current = true
          recRef.current.cancel()
          recRef.current = null
          releaseMic(sid)
          setVoice('idle')
          setVoiceLevel(0)
          setVoiceNote('')
          return true
        }
        if (overlayOpen) return false
        const conv = convForSession(useAiStore.getState(), sid)
        if (!conv) return false
        // 2. Висит гейт — Esc отклоняет его.
        const pendingRun = nextGate(conv)
        if (pendingRun) {
          useAiStore.getState().denyTool(conv.id, pendingRun.id)
          return true
        }
        // 3. Непустая очередь — Esc забирает СВОЮ приписку обратно в строку и НЕ
        //    трогает агента. Так устроен CLI: в транскриптах 103 из 103 случаев
        //    `queue-operation: remove` идут без `[Request interrupted by user]`.
        if (conv.queued) {
          const q = useAiStore.getState().takeQueued(conv.id)
          if (!q) return true
          setHistIdx(-1)
          setText((prev) =>
            prev.trim()
              ? `${q}
${prev}`
              : q
          )
          focusInputEnd()
          return true
        }
        if (!conv.streaming) return false
        if (conv.pendingTools.some((t) => t.kind === 'question' && !t.settled)) return false
        // 4. Отмена ОТПРАВЛЕННОГО сообщения: уходит из ленты И из памяти агента,
        //    текст возвращается в строку. Умеет только Claude Code; на остальных
        //    движках undoSend вернёт null, и Esc остаётся прерыванием хода.
        void useAiStore
          .getState()
          .undoSend(conv.id)
          .then((text) => {
            if (text === null) {
              useAiStore.getState().abort(conv.id)
              return
            }
            setHistIdx(-1)
            setText((prev) =>
              prev.trim()
                ? `${text}
${prev}`
                : text
            )
            focusInputEnd()
          })
        return true
      },
      onEnter: () => {
        const conv = convForSession(useAiStore.getState(), sid)
        if (!conv) return false
        const pendingRun = nextGate(conv)
        if (!pendingRun) return false
        // Одобряет только пустое поле и только когда курсор не в другом поле
        // ввода: Enter в чужой форме не должен запускать инструмент.
        const ae = document.activeElement as HTMLElement | null
        const inOtherField =
          !!ae &&
          ae !== ref.current &&
          (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        if (inOtherField || ref.current?.value.trim()) return false
        void useAiStore.getState().approveTool(conv.id, pendingRun.id)
        return true
      }
    })
  }, [activeSessionId])

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
    // Только СВОЯ панель: чужой ход — не выбор человека, и общим умолчанием
    // для следующих панелей он становиться не должен.
    if (paneSessionId) setPaneBarMode(paneSessionId, want)
    else if (useUiStore.getState().barMode !== want) useUiStore.getState().set({ barMode: want })
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
    pushPaneHistory(activeSessionId, cmd)
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
      setRaw(activeSessionId, true)
      setTimeout(() => getTerminal(activeSessionId)?.focus(), 60)
    }
    window.zarya.pty.write(activeSessionId, cmd + '\r')
  }

  const askAgent = (agentEngine: 'builtin' | AgentEngine): void => {
    const q = text.trim()
    if (!q) return
    pushPaneHistory(activeSessionId, q)
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
        pushPaneHistory(activeSessionId, t)
        setHistIdx(-1)
        useAiStore.getState().queueMessage(activeConv.id, t)
        setText('')
      }
      return
    }
    askAgent(engine)
  }

  /*
   * Команды движка для «/».
   *
   * Список берётся у самого движка (Claude Code отдаёт его SDK-методом
   * supportedCommands) и живёт в памяти панели. Грузится один раз при первом
   * вызове «/», а не при открытии панели: у большинства запусков команду никто
   * не набирает, а поднимать ради этого лишний процесс — плата ни за что.
   */
  const [cmdList, setCmdList] = useState<AgentCommand[]>([])
  const [cmdSource, setCmdSource] = useState<'engine' | 'unknown'>('engine')
  /*
   * Список приходит не мгновенно: у Claude Code это ~2 секунды (SDK поднимает
   * процесс и спрашивает CLI). Пока он идёт, показывать «0 команд» нельзя —
   * человек прочитает это как «команд нет» и уйдёт, а правда — «ещё спрашиваю».
   */
  const [cmdLoading, setCmdLoading] = useState(false)
  const [cmdCursor, setCmdCursor] = useState(0)
  const cmdLoaded = useRef(false)
  /** Что набрано после «/» прямо сейчас; null — список закрыт. */
  const [cmdQuery, setCmdQuery] = useState<string | null>(null)
  /**
   * Текст в момент, когда команду ВЫБРАЛИ.
   *
   * Без этого список открывался снова сразу после подстановки: строка «/review»
   * по всем признакам и есть начатая команда. Но человек уже ответил на этот
   * вопрос — снова показывать ему тот же список значит спорить с его выбором.
   * Список вернётся, как только текст изменится.
   */
  const pickedText = useRef<string | null>(null)

  const commandsShown = useMemo(
    () => (cmdQuery === null ? [] : matchCommands(cmdList, cmdQuery)),
    [cmdList, cmdQuery]
  )

  /*
   * Список команд принадлежит БЕСЕДЕ, а не приложению: проектные скиллы лежат
   * в `.claude/skills` рядом с кодом, и у панели в другом репозитории они
   * другие. Поэтому кэш сбрасывается при смене беседы или движка — иначе в «/»
   * остались бы скиллы соседнего проекта, то есть список врал бы.
   */
  const cmdOwner = useRef<string>('')
  const loadCommands = (): void => {
    const owner = `${mode}:${activeConv?.id ?? ''}`
    if (cmdLoaded.current && cmdOwner.current === owner) return
    cmdLoaded.current = true
    cmdOwner.current = owner
    const engine = mode === 'zarya' || mode === 'shell' ? null : (mode as AgentEngine)
    if (!engine) {
      setCmdSource('unknown')
      return
    }
    setCmdLoading(true)
    void window.zarya.agent
      .listCommands(engine, activeConv?.id)
      .then((r) => {
        setCmdList(cleanCommands(r?.commands))
        setCmdSource(r?.source === 'engine' ? 'engine' : 'unknown')
      })
      .catch(() => setCmdSource('unknown'))
      .finally(() => setCmdLoading(false))
  }

  /** Пересчитать, открыт ли список, по тексту и позиции каретки. */
  const syncCommandQuery = (value: string, caret: number): void => {
    if (pickedText.current !== null && value === pickedText.current) {
      setCmdQuery(null)
      return
    }
    pickedText.current = null
    const q = commandQuery(value, caret)
    setCmdQuery(q)
    if (q !== null) {
      loadCommands()
      setCmdCursor(0)
    }
  }

  const pickCommand = (cmd: AgentCommand, el?: HTMLTextAreaElement | null): void => {
    const caret = el?.selectionStart ?? text.length
    const next = applyCommand(text, caret, cmd)
    setText(next.text)
    setCmdQuery(null)
    pickedText.current = next.text
    // Каретка встаёт за подставленным именем — иначе следующий символ уедет в
    // начало строки, и человек будет думать, что список «сломал ввод».
    requestAnimationFrame(() => {
      const node = el ?? ref.current
      if (node) {
        node.focus()
        node.selectionStart = node.selectionEnd = next.caret
      }
    })
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
      const barHistory = paneHistory(activeSessionId)
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
      const barHistory = paneHistory(activeSessionId)
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
        .toast(t('bar.engineBusy'), 'info')
      return
    }
    const order = modeCycle(Object.keys(agentCaps))
    const next = order[(order.indexOf(mode) + 1) % order.length] ?? 'shell'
    // Явный выбор человека: он же становится умолчанием для новых панелей.
    setBarModeOf(paneSessionId, next)
    setTimeout(() => ref.current?.focus(), 0)
  }

  /**
   * Принять картинки в СВОЮ панель. Общая точка для Ctrl+V и перетаскивания:
   * оба жеста обязаны попадать туда, где стоит курсор, а не «в активную».
   */
  const acceptImages = async (files: File[]): Promise<number> => {
    if (!activeSessionId || !files.length) return 0
    // Движок, который картинок не принимает, не должен молча их проглатывать:
    // отправить запрос без вложения — соврать о том, что агент их видел.
    if (activeEngine && agentCaps[activeEngine]?.images !== true) {
      useUiStore
        .getState()
        .toast(t('bar.noImages', { engine: modeLabel(mode) }), 'error')
      return 0
    }
    let added = 0
    for (const file of files) {
      const current = useAiStore.getState().pendingImages[activeSessionId] ?? []
      const room = canAcceptMore(current, file.size)
      if (!room.ok) {
        useUiStore.getState().toast(room.reason, 'error')
        break
      }
      const res = await fileToAttachment(file)
      if (!res.ok) {
        useUiStore.getState().toast(res.reason, 'error')
        continue
      }
      useAiStore.getState().attachImage(activeSessionId, res.att)
      added++
    }
    return added
  }

  const openLaunchPad = (): void => useUiStore.getState().set({ launchPadOpen: true })

  /**
   * Режим плана: агент ничего не выполняет, пока не расскажет, что собирается.
   *
   * Как и автопилот, решение запоминается за ПАНЕЛЬЮ, чтобы чип работал до
   * первого сообщения. Тон подсказки обратный автопилоту: включение здесь —
   * осторожность, а не риск.
   */
  const togglePlanMode = (): void => {
    const next = !planMode
    if (activeConv) useAiStore.getState().setPlanMode(activeConv.id, next)
    else if (activeSessionId) useAiStore.getState().setPanePlanMode(activeSessionId, next)
    else return
    useUiStore
      .getState()
      .toast(next ? t('bar.planToastOn') : t('bar.planToastOff'), 'success')
  }

  /**
   * Замок по кругу: спрашивать → правки без спроса → автопилот → спрашивать.
   *
   * Это жест Claude Code (там Shift+Tab), и он же делает Зарю СТРОЖЕ прежнего:
   * раньше один щелчок по замку сразу включал автопилот, теперь между ними
   * стоит ступень, на которой молча проходят только правки файлов, а команды
   * оболочки по-прежнему спрашивают.
   *
   * В режиме плана цикла нет: там выполнять нечего, и предлагать ослабление
   * закрытого наглухо гейта — обещание без предмета.
   */
  const cycleGate = (): void => {
    if (!canToggleGate) return
    if (isBuiltinMode) {
      toggleAutoApprove()
      return
    }
    const store = useAiStore.getState()
    const apply = (edits: boolean, auto: boolean): void => {
      if (activeConv) {
        store.setEditsAuto(activeConv.id, edits)
        store.setBypass(activeConv.id, auto)
      } else if (activeSessionId) {
        store.setPaneEditsAuto(activeSessionId, edits)
        store.setPaneBypass(activeSessionId, auto)
      }
    }
    if (bypass) {
      apply(false, false)
      useUiStore.getState().toast(t('bar.gateToastAsk'), 'success')
      return
    }
    if (editsAuto) {
      apply(false, true)
      useUiStore.getState().toast(t('bar.autopilotToastOn'), 'error')
      return
    }
    apply(true, false)
    useUiStore.getState().toast(t('bar.gateToastEdits'), 'success')
  }

  const toggleBypass = (): void => {
    const next = !bypass
    // Беседа появляется только с первым сообщением, а решение принимается
    // сейчас: запоминаем за панелью, чтобы чип не был мёртвым до отправки.
    if (activeConv) useAiStore.getState().setBypass(activeConv.id, next)
    else if (activeSessionId) useAiStore.getState().setPaneBypass(activeSessionId, next)
    else return
    useUiStore
      .getState()
      .toast(
        next
          ? t('bar.autopilotToastOn')
          : t('bar.autopilotToastOff'),
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
    // Микрофон свободен, как только устройство закрыто: расшифровка идёт уже без
    // него, и держать замок на время распознавания значило бы запирать соседние
    // панели просто так.
    releaseMic(activeSessionId)
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
      setVoiceNote(res.error ?? t('voice.failed'))
      useUiStore.getState().toast(res.error ?? t('voice.failedLong'), 'error')
      return
    }
    setVoiceNote('')
    const said = (res.text ?? '').trim()
    if (!said) {
      useUiStore.getState().toast(t('voice.nothing'), 'error')
      return
    }
    setText((t) => (t ? `${t} ${said}` : said))
    setTimeout(() => ref.current?.focus(), 0)
  }

  const startVoice = async (): Promise<void> => {
    if (recRef.current || voice !== 'idle') return
    // Микрофон один на машину. Замок на всё приложение, а не внутри строки:
    // строк станет столько же, сколько панелей, и каждая проходила бы СВОЮ
    // защиту — четыре записи одной фразы и четыре расшифровки.
    if (!activeSessionId || !claimMic(activeSessionId)) {
      useUiStore.getState().toast(t('voice.busy'), 'error')
      return
    }
    // Claim the slot BEFORE the first await. Two entry points can fire almost
    // together (button click and the push-to-talk key), and both would pass the
    // guard above while awaiting — opening two microphones and orphaning the
    // first Recording with the device still live.
    setVoice('load')
    // Флаг описывает ТОЛЬКО эту попытку. Esc во время записи ставит его, когда
    // никакого startVoice в полёте нет (recRef уже очищен), и он оставался
    // взведённым до следующего нажатия: та диктовка открывала микрофон и тут же
    // сама себя отменяла — без записи и без единого слова. Работало лишь третье
    // нажатие. Сброс идёт там же, где захватывается слот.
    voiceCancelled.current = false
    // Настройки читаются из стора, а не из замыкания рендера: push-to-talk
    // подписан эффектом с deps [voice], а смена микрофона `voice` не меняет —
    // слушатель горячей клавиши держал startVoice со СТАРЫМ voiceCfg, и первая
    // же диктовка после переключения шла в прежнее устройство, пока подсказка на
    // кнопке показывала новое. Ровно та тихая подмена, ради которой всё писалось.
    const cfg = useSettingsStore.getState().settings.voice
    const state = await window.zarya.stt.state()
    if (!state.modelReady) {
      // First run downloads ~225 MB — say so instead of appearing frozen.
      setVoiceNote(t('voice.loadingModel'))
      const r = await window.zarya.stt.ensureModel()
      setVoiceNote('')
      if (!r?.ok) {
        setVoice('idle')
        useUiStore.getState().toast(r?.error ?? t('voice.modelFailed'), 'error')
        return
      }
    }
    try {
      // Какой микрофон открывать, решает resolveMic: сохранённый id, если он на
      // месте; то же устройство под новым id, если id сменился; системное — если
      // выбранного больше нет. Список запрашивается перед каждой записью: между
      // диктовками гарнитуру успевают и отключить, и воткнуть обратно.
      const devices = await listMics()
      setMics(devices)
      const pick = resolveMic(devices, cfg)
      if (pick.kind === 'relabelled') {
        // То же устройство под новым id — чиним настройку молча: для человека
        // ничего не изменилось, он по-прежнему говорит в свою гарнитуру.
        void useSettingsStore
          .getState()
          .update({ voice: { deviceId: pick.deviceId, deviceLabel: pick.label } as never })
      }
      if (pick.kind === 'missing') {
        // Раз за запуск на устройство: списанная гарнитура иначе давала бы
        // всплывашку на каждую диктовку. Что выбор не найден, всё равно видно —
        // в подсказке на кнопке и отдельной строкой в настройках.
        if (!warnedMissingMics.has(cfg.deviceId)) {
          warnedMissingMics.add(cfg.deviceId)
          useUiStore
            .getState()
            .toast(t('voice.micMissing', { name: pick.label }), 'error')
        }
      } else {
        // Устройство вернулось — право на предупреждение восстановлено. Без
        // этого второе исчезновение той же гарнитуры прошло бы молча, и запись
        // ушла бы в системный микрофон без единого слова.
        warnedMissingMics.delete(cfg.deviceId)
      }
      let lost = false
      const rec = await startRecording(pickDeviceId(pick), {
        onDeviceLost: () => {
          lost = true
          recRef.current = null
          releaseMic(activeSessionId)
          setVoice('idle')
          setVoiceLevel(0)
          useUiStore.getState().toast(t('voice.micLost'), 'error')
        }
      })
      // Бар ушёл с экрана, пока открывался микрофон: его cleanup уже прошёл и
      // отменять ему было нечего. Закрываем сами — иначе устройство останется
      // открытым навсегда, а кнопки, которой это можно прекратить, уже нет.
      if (!aliveRef.current) {
        rec.cancel()
        releaseMic(activeSessionId)
        return
      }
      // Someone cancelled while getUserMedia was resolving — release the device
      // instead of leaving it open behind a state that says «idle».
      if (voiceCancelled.current) {
        rec.cancel()
        voiceCancelled.current = false
        releaseMic(activeSessionId)
        setVoice('idle')
        return
      }
      // Устройство успело отвалиться, пока промис резолвился: держать мёртвую
      // запись в recRef — значит показывать индикатор над закрытым микрофоном.
      if (lost) {
        releaseMic(activeSessionId)
        setVoice('idle')
        return
      }
      // Устройство отвалилось между enumerateDevices и getUserMedia.
      if (rec.fellBackToDefault) {
        useUiStore
          .getState()
          .toast(
            t('voice.micUnavailable', { name: cfg.deviceLabel || t('voice.chosen') }),
            'error'
          )
      }
      recRef.current = rec
      setVoice('rec')
    } catch (e) {
      // Запрет в системных настройках приходит тем же NotAllowedError, что и
      // отказ на уровне страницы, но чинится он в другом месте — «микрофон
      // недоступен» отправило бы человека искать поломку не там.
      const name = e instanceof Error ? e.name : ''
      const msg =
        name === 'NotAllowedError'
          ? t('voice.denied')
          : name === 'NotFoundError'
            ? t('voice.notFound')
            : e instanceof Error
              ? e.message
              : t('voice.unavailable')
      useUiStore.getState().toast(msg, 'error')
      setVoice('idle')
    }
  }

  /**
   * Выбор микрофона по правому клику на кнопке — там, где о нём и вспоминают:
   * когда надиктованное ушло не в ту гарнитуру. То же самое лежит в настройках
   * («Голос»), но лезть туда посреди работы никто не станет.
   */
  const micItems = (devices: MicDevice[], at: { x: number; y: number }): MenuItem[] => {
    const list = usableMics(devices)
    // Именно общий помощник, а не своя копия условия: копия разошлась бы с
    // настройками, и одно и то же состояние читалось бы по-разному в двух местах.
    const hidden = labelsHidden(devices)
    const items: MenuItem[] = [
      {
        label: t('voice.systemDefault'),
        hint: voiceCfg.deviceId ? undefined : '✓',
        onClick: () =>
          void useSettingsStore
            .getState()
            .update({ voice: { deviceId: '', deviceLabel: '' } as never })
      }
    ]
    if (list.length) items.push({ separator: true })
    list.forEach((d, i) => {
      const name = micName(d, i)
      items.push({
        label: name,
        hint: d.deviceId === voiceCfg.deviceId ? '✓' : undefined,
        onClick: () =>
          void useSettingsStore
            .getState()
            .update({ voice: { deviceId: d.deviceId, deviceLabel: d.label } as never })
      })
    })
    // Выбранного устройства нет в списке. Без этой строки меню показывало бы
    // выбор ненажатым нигде — как будто ничего и не выбрано.
    if (voiceCfg.deviceId && !list.some((d) => d.deviceId === voiceCfg.deviceId)) {
      items.push({
        label: t('voice.chosenMissing', { name: voiceCfg.deviceLabel || t('voice.chosenMic') }),
        hint: '✓',
        disabled: true
      })
    }
    if (hidden) {
      // Названия скрыты, пока странице не давали доступ к микрофону (на Windows
      // не случается — там разрешение уже выдано; ветка для macOS/Linux, где
      // гейтит ОС). Открывать микрофон ради списка сами не будем — только по
      // явному нажатию.
      items.push({ separator: true })
      items.push({
        label: t('voice.revealNames'),
        hint: t('voice.needsAccess'),
        onClick: () => {
          void revealMicLabels()
            .then((fresh) => {
              setMics(fresh)
              openMicMenu(at.x, at.y, micItems(fresh, at))
            })
            .catch(() => useUiStore.getState().toast(t('voice.accessDenied'), 'error'))
        }
      })
    }
    if (!list.length) {
      items.push({ separator: true })
      items.push({ label: t('voice.noMics'), disabled: true })
    }
    if (voice === 'rec') {
      items.push({ separator: true })
      items.push({ label: t('voice.appliesNext'), disabled: true })
    }
    return items
  }

  const openMicPicker = (x: number, y: number): void => {
    void listMics().then((devices) => {
      setMics(devices)
      openMicMenu(x, y, micItems(devices, { x, y }))
    })
  }

  const cancelVoice = (): void => {
    voiceCancelled.current = true
    recRef.current?.cancel()
    recRef.current = null
    setVoice('idle')
    setVoiceLevel(0)
    setVoiceNote('')
  }

  // Список устройств для подсказки на кнопке — чтобы «какой микрофон слушают»
  // читалось наведением, а не выяснялось по расшифровке. Названия здесь могут
  // быть пустыми (доступ ещё не выдан) — это нормально, имя берётся из настроек.
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void listMics().then((d) => {
        if (alive) setMics(d)
      })
    }
    refresh()
    const off = onDeviceChange(refresh)
    return () => {
      alive = false
      off()
    }
  }, [])

  const micLabel = ((): string => {
    if (!voiceCfg.deviceId) return t('voice.system')
    const list = usableMics(mics)
    const i = list.findIndex((d) => d.deviceId === voiceCfg.deviceId)
    if (i >= 0) return micName(list[i], i)
    // Выбранного устройства в списке нет — писать будут в системное. Назвать
    // здесь одно имя, а записать другое, значит соврать ровно в том месте, куда
    // человек и смотрит, чтобы это проверить. Пустой список не в счёт: он
    // означает, что перечисление ещё не вернулось, а не что устройство пропало.
    const name = voiceCfg.deviceLabel || t('voice.chosen')
    return list.length ? t('voice.fallbackToSystem', { name }) : name
  })()

  // The microphone must close itself. The bar unmounts WITHOUT the user doing
  // anything about dictation — Ctrl+` or a TUI taking over the terminal drops
  // it — and an abandoned Recording keeps the device open for the life of the
  // process, with no button left on screen to stop it. Empty deps on purpose:
  // this must run only on unmount, never when `voice` changes.
  // Отдельно — размонтирование ПОСРЕДИ открытия микрофона: этот cleanup уже
  // отработал (recRef пуст, отменять нечего), а getUserMedia ещё в полёте.
  // Резолв присваивал recRef на мёртвом компоненте — кнопки больше нет, а
  // устройство остаётся открытым до конца жизни процесса, с горящим индикатором
  // микрофона в системе. Флаг живёт в ref и переживает cleanup.
  useEffect(
    () => () => {
      aliveRef.current = false
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

  // Закрепить режим за панелью при рождении. Без этого панель, в которой режим
  // ни разу не выбирали, продолжала бы читать общее умолчание — и менялась бы
  // вместе с ним, когда режим переключают в СОСЕДНЕЙ панели.
  useEffect(() => {
    if (!paneSessionId) return
    const st = useUiStore.getState()
    if (!st.barModeBySession[paneSessionId]) setPaneBarMode(paneSessionId, st.barMode)
  }, [paneSessionId])

  // Отзеркалить набранное: закрытие панели приходит снаружи (крестик в сайдбаре,
  // пункт меню) и обязано знать, теряется ли при этом текст. Строка ввода
  // остаётся владельцем текста — сюда уходит только копия для вопроса.
  //
  // Черновик переживает УХОД СТРОКИ С ЭКРАНА. Запуск vim, htop или любой
  // команды из списка интерактивных сам включает сырой режим, строка при этом
  // размонтируется — и набранный запрос исчезал вместе с ней, без вопроса и
  // следа. Теперь текст возвращается на место, когда программа закрылась
  // (начальное значение поля берётся отсюда же). Забывает его только закрытие
  // панели.
  useEffect(() => {
    setPaneDraft(activeSessionId, text)
  }, [activeSessionId, text])

  /*
   * Текст, пришедший снаружи: путь перетащенного файла и всё, что появится
   * после него. Дописываем к набранному через пробел, а не заменяем — человек
   * тащит файл В ФРАЗУ («посмотри ») куда чаще, чем в пустую строку.
   */
  useEffect(() => {
    return onBus('input:insert', ({ sessionId: sid, text: add }) => {
      if (sid !== paneSessionId || !add) return
      setHistIdx(-1)
      setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${add}` : add))
      focusInputEnd()
    })
  }, [paneSessionId])

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
      setVoiceNote(t('voice.modelProgress', { pct }))
    })
  }, [])

  // Push-to-talk: hold the key, speak, release. Ignored while typing in a field.
  //
  // Слушают ОКНО все смонтированные строки — по одной на панель, включая панели
  // неактивных вкладок. Поэтому первым делом каждая проверяет, ей ли адресовано
  // нажатие: без этого на четырёх панелях один хоткей открывал микрофон в той,
  // что смонтирована первой, расшифровка уезжала в чужую строку, а остальные
  // три выдавали красное «микрофон занят другой панелью».
  useEffect(() => {
    const isHotkey = (e: KeyboardEvent): boolean => e.ctrlKey && e.shiftKey && e.code === 'Space'
    const mine = (): boolean =>
      !paneSessionId || useSessionsStore.getState().activeSessionId() === paneSessionId
    const down = (e: KeyboardEvent): void => {
      if (!isHotkey(e) || e.repeat || !mine()) return
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
          ? t('bar.autoApproveOn')
          : t('bar.autoApproveOff'),
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
      return { short: t('usage.weekShort'), label: t('usage.weekLimit'), pct: seven }
    return { short: t('usage.fiveShort'), label: t('usage.fiveLimit'), pct: five as number }
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
  // lands a turn still goes out with the conversation's own `bypass`.
  // Collapsing unknown into false made the chip claim «always asks» while the
  // driver was auto-allowing — the exact lie it exists to prevent. Lock it only
  // on an explicit bypass:false.
  const isBuiltinMode = mode === 'zarya'
  // В режиме плана агент не выполняет ничего — спрашивать не о чем, и замок
  // здесь не переключатель, а состояние. Оставить его живым значило бы предлагать
  // ослабить гейт, который сейчас и так закрыт наглухо.
  const canToggleGate = !planMode && (isBuiltinMode || caps?.bypass !== false)
  const gateOff = !planMode && (isBuiltinMode ? autoApprove : bypass && caps?.bypass !== false)
  // Средняя ступень видна отдельно: «правки молча, команды со спросом» — не то
  // же самое, что «спрашивать всё», и уж точно не автопилот.
  const gateEdits = !planMode && !isBuiltinMode && editsAuto && !gateOff
  const gateTitle = isBuiltinMode
    ? gateOff
      ? t('bar.gateBuiltinOn')
      : t('bar.gateBuiltinOff')
    : !canToggleGate
      ? t('bar.gateLocked', { engine: modeLabel(mode) })
      : gateOff
        ? t('bar.gateOn')
        : gateEdits
          ? t('bar.gateEdits')
          : t('bar.gateOff')

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
      {/* Появились новые скиллы или MCP — предложить подхватить без перезапуска
          сессии. Рядом со списком команд: обе полосы про состав того, чем агент
          умеет пользоваться. */}
      {mode !== 'zarya' && mode !== 'shell' && (
        <ExtrasBar engine={mode as AgentEngine} requestId={activeConv?.id} />
      )}
      {/* Список команд движка: вырастает НАД строкой, строка остаётся на месте
          и остаётся полем — человек продолжает печатать, список сужается. */}
      {cmdQuery !== null && (
        <CommandList
          commands={commandsShown}
          cursor={cmdCursor}
          source={cmdSource}
          loading={cmdLoading}
          onPick={(c) => pickCommand(c, ref.current)}
          onHover={setCmdCursor}
        />
      )}
      {usageOpen && (
        <UsagePanel
          usage={showFuel ? claudeStatus.usage : undefined}
          context={agentContext}
          onClose={() => setUsageOpen(false)}
          anchor={fuelBtnRef.current}
        />
      )}
      {/* One headline figure, not four readings queued on a single line. The rest
          opens on demand — see UsagePanel. */}
      {/* Топливомер общий на окно и живёт в нижней полосе: четыре одинаковых
          индикатора показывали бы одно и то же число, отнимая место у работы. */}
      {!paneSessionId && (
        <div className="zy-agentbar-fuel">
        <button
          ref={fuelBtnRef}
          className="zy-agentbar-fuel-main"
          title={
            lead
              ? t('usage.leadHint', { label: lead.label, pct: Math.round(lead.pct) })
              : t('usage.allHint')
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
              {t(showFuel ? 'strip.fueled' : 'strip.noLimit')}
            </span>
          )}
          <Icon name={usageOpen ? 'chevron-down' : 'chevron-up'} size={10} />
        </button>
        <span className="zy-agentbar-fuel-spacer" />
        {/*
          Во сколько обошёлся ЭТОТ разговор — цифра самого движка, которую он
          считал всегда, а мы выбрасывали.

          Подпись обязательна и разная. На подписке это РАСЧЁТ по тарифам API:
          деньги за ход не списываются, и показать сумму молча значит соврать
          человеку о его деньгах. По своему ключу — наоборот, это счёт, который
          он оплатит.
        */}
        {costLabel && (
          <span
            className="zy-agentbar-fuel-cost"
            title={t(onPlan ? 'bar.costHintPlan' : 'bar.costHintApi')}
          >
            {costLabel}
          </span>
        )}
        {showModel && (paneStatus.model || paneStatus.effort || ultracode) && (
          <button
            className="zy-agentbar-fuel-model"
            onClick={openLaunchPad}
            title={t('bar.engineHint')}
          >
            {paneStatus.model ? prettyModel(paneStatus.model) : ''}
            {ultracode
              ? ' · ⚡ULTRACODE'
              : paneStatus.effort
                ? ` · ${paneStatus.effort.toUpperCase()}`
                : ''}
          </button>
        )}
          <button
            className="zy-agentbar-fuel-pult"
            onClick={openLaunchPad}
            title={t('bar.launchPad')}
          >
            {t('strip.console')}
          </button>
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="zy-img-chips">
          {pendingImages.map((img, i) => (
            <span key={img.id} className="zy-img-chip" title={`${img.width}×${img.height} · ${Math.round(img.bytes / 1024)} ${t('common.kb')}`}>
              {img.thumb ? <img src={img.thumb} alt="" /> : null}
              <span className="zy-img-chip-n">#{i + 1}</span>
              <span className="zy-img-chip-name">{img.name ?? t('bar.snapshot')}</span>
              <button
                className="zy-img-chip-x"
                title={t('bar.removeAttachment')}
                onClick={() => activeSessionId && useAiStore.getState().dropImage(activeSessionId, img.id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        className={`zy-agentbar-row${dragOver ? ' zy-agentbar-row--drag' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          // stopPropagation обязателен: без него дроп всплывёт в общий
          // обработчик окна и вместо вложения откроется новый терминал.
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
          const all = imageFilesFrom(e.dataTransfer)
          const imgs = all.filter((f) => f.type.startsWith('image/'))
          void acceptImages(imgs)
          // Файл-не-картинка идёт ПУТЁМ, а не содержимым: агент прочитает его
          // сам своим инструментом под гейтом и не потратит контекст на
          // мегабайт, который может не понадобиться.
          const others = all.filter((f) => !f.type.startsWith('image/'))
          if (others.length) {
            // Кавычки ставит общий модуль: путь, брошенный в строку и в тело
            // панели, обязан выглядеть одинаково — и одинаково безопасно.
            const paths = others
              .map((f) => window.zarya.app.getPathForFile(f))
              .filter(Boolean)
              .map((x) => quotePath(x))
            if (paths.length) {
              setText((prev) => (prev.trim() ? `${prev} ${paths.join(' ')}` : paths.join(' ')))
              useUiStore.getState().toast(t('bar.fileAsPath'), 'success')
            }
          }
        }}
      >
        {/* Icon-only chips: the engine and the gate are permanent fixtures, and
            spelling them out in full caps ate the bar. The label lives in the
            tooltip; the gate additionally keeps its colour, because «will I be
            asked?» must stay readable without hovering. */}
        <button
          className={`zy-agentbar-mode zy-agentbar-mode--icon zy-agentbar-mode--${mode}`}
          title={
            isShell
              ? t('bar.modeShellHint')
              : isAgent
                ? t('bar.modeAgentHint', { engine: modeLabel(mode) })
                : t('bar.modeZaryaHint')
          }
          aria-label={t('bar.modeAria', { engine: modeLabel(mode) })}
          onClick={cycleMode}
        >
          <EngineGlyph engine={mode} size={14} />
        </button>
        {/*
          РЕЖИМ ПЛАНА. Отдельным чипом, а не третьим состоянием замка: тот
          дал бы одному нажатию путь от самого строгого режима к самому
          свободному, а это разные решения с разной ценой ошибки.

          Чипа НЕТ там, где движок так не умеет: переключатель, который движок
          пропустит мимо ушей, обещает осторожность, которой не будет.
        */}
        {!isShell && !isBuiltinMode && caps?.planMode === true && (
          <button
            className={`zy-agentbar-plan${planMode ? ' zy-agentbar-plan--on' : ''}`}
            title={planMode ? t('bar.planOnHint') : t('bar.planOffHint')}
            aria-label={t(planMode ? 'bar.planOnHint' : 'bar.planOffHint')}
            aria-pressed={planMode}
            onClick={togglePlanMode}
          >
            <PixelIcon name="workflows" />
          </button>
        )}
        {!isShell && (
          <button
            className={`zy-agentbar-bypass zy-agentbar-bypass--icon${
              gateOff ? ' zy-agentbar-bypass--on' : ''
            }${gateEdits ? ' zy-agentbar-bypass--edits' : ''}${
              canToggleGate ? '' : ' zy-agentbar-bypass--locked'
            }`}
            title={gateTitle}
            aria-label={t(gateOff ? 'bar.autopilotAria' : gateEdits ? 'bar.editsAria' : 'bar.manualAria')}
            disabled={!canToggleGate}
            onClick={canToggleGate ? cycleGate : undefined}
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
              ? t('bar.recording')
              : voice === 'load'
                ? t('voice.modelLoading')
                : voice === 'work'
                  ? t('voice.recognising')
                  : micBusy
                    ? t('bar.micBusy')
                    : t('voice.hint', { mic: micLabel })
          }
          aria-label={t('bar.dictate')}
          onClick={() => (voice === 'rec' ? void finishVoice() : void startVoice())}
          // Правый клик по кнопке — выбор микрофона, и ТОЛЬКО он. Без остановки
          // всплытия событие доходило до панели, та открывала своё меню
          // («Копировать», «Разделить вправо»…), и на экране оказывались два
          // меню внахлёст: одно спрашивает про устройство, другое — про панель.
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            openMicPicker(r.left, r.top - 8)
          }}
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
        onPaste={(e) => {
          const files = imageFilesFrom(e.clipboardData).filter((f) =>
            f.type.startsWith('image/')
          )
          if (!files.length) return
          // Текстовую часть буфера вставляем сами: preventDefault отменил бы её
          // вместе с картинкой, и человек потерял бы скопированный текст.
          e.preventDefault()
          const txt = e.clipboardData.getData('text/plain')
          if (txt) setText((prev) => prev + txt)
          void acceptImages(files)
        }}
        // Курсор в поле — панель становится активной. Без этого «панель, куда я
        // печатаю» и «панель, на которую действует Enter» расходятся: можно
        // одобрить запуск команды, которую даже не видел.
        onFocus={() => {
          if (paneSessionId) useSessionsStore.getState().setActiveSession(paneSessionId)
        }}
          className="zy-agentbar-input"
          rows={1}
          placeholder={
            busyConv && mode !== 'shell'
              ? t('bar.busy')
              : paneSessionId
                ? // В панели места вчетверо меньше, и приписка «(Enter — выполнить)»
                  // не влезала: подсказка обрывалась на полуслове. Что делает Enter,
                  // написано на кнопке отправки и на чипе режима.
                  modePlaceholder(mode).replace(/\s*\(.*\)\s*$/, '')
                : modePlaceholder(mode)
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            syncCommandQuery(e.target.value, e.target.selectionStart ?? e.target.value.length)
            // The user edited a recalled item → leave history-browse mode.
            if (histIdx !== -1 && e.target.value !== paneHistory(activeSessionId)[histIdx])
              setHistIdx(-1)
          }}
          // Каретку двигают не только набором: клик и стрелки влево-вправо тоже
          // меняют ответ на вопрос «человек сейчас пишет команду или путь».
          onSelect={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement
            syncCommandQuery(el.value, el.selectionStart ?? el.value.length)
          }}
          onBlur={() => setCmdQuery(null)}
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
            /*
             * Пока открыт список команд, стрелки и Enter принадлежат ЕМУ.
             *
             * Порядок здесь важнее самого списка: ↑/↓ в этой строке уже заняты
             * историей панели, а Enter — отправкой. Ошибка в приоритете ломает
             * не список, а историю — то есть регрессию искали бы совсем в
             * другом месте.
             */
            if (cmdQuery !== null && commandsShown.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCmdCursor((i) => (i + 1) % commandsShown.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCmdCursor((i) => (i - 1 + commandsShown.length) % commandsShown.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickCommand(commandsShown[cmdCursor], e.currentTarget as HTMLTextAreaElement)
                return
              }
            }
            if (cmdQuery !== null && e.key === 'Escape') {
              // Список закрывается, набранное остаётся: Esc здесь — «убери
              // подсказку», а не «сотри мой текст».
              e.preventDefault()
              e.stopPropagation()
              setCmdQuery(null)
              return
            }
            if (onNavKey(e)) return
            /*
             * Ctrl+C — то же, что в терминале: «остановись».
             *
             * Раньше клавиша не значила здесь ничего, и прервать команду,
             * запущенную из этой же строки, было нечем — приходилось щёлкать в
             * терминал. Порядок разбора: выделенный текст всё так же копируется
             * (жест старше нас), в режиме агента прерывается ход, в остальных
             * случаях сигнал уходит в оболочку.
             */
            if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[cсC]$/i.test(e.key)) {
              const el = e.currentTarget as HTMLTextAreaElement
              const hasSelection = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0)
              if (hasSelection) return
              if (!activeSessionId) return
              const conv = convForSession(useAiStore.getState(), activeSessionId)
              const running = paneIsRunning(activeSessionId)
              const agentBusy = !!conv?.streaming && !isShell && !running
              e.preventDefault()
              if (agentBusy) {
                useAiStore.getState().abort(conv.id)
                return
              }
              interruptPane(activeSessionId)
              /*
               * Прерывать нечего — тогда Ctrl+C делает то же, что в любом
               * терминале у пустого приглашения: отбрасывает набранное.
               *
               * Иначе клавиша не давала НИКАКОГО признака работы: `^C` рисует
               * оболочка, а в блочном режиме терминал накрыт лентой, и человек
               * видел ровно то же, что и до нажатия, — то есть «не работает».
               */
              if (!running && text) {
                setHistIdx(-1)
                setText('')
              }
              return
            }
            /*
             * Shift+Tab — цикл режимов допуска, тот же жест, что в консоли.
             *
             * Самая частая клавиша Claude Code: рефакторинг начинают с вопросов
             * на каждую правку и на третьей карточке переключаются. Голый Tab
             * оставлен списку команд — он выбирает подсказку.
             */
            if (e.key === 'Tab' && e.shiftKey && !isShell && !isBuiltinMode) {
              e.preventDefault()
              cycleGate()
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              doAction()
            } else if ((e.ctrlKey || e.metaKey) && /^[iшI]$/i.test(e.key)) {
              // Ctrl+I → jump into Claude Code mode (and send if there's text).
              e.preventDefault()
              if (mode !== 'claude-code') setBarModeOf(paneSessionId, 'claude-code')
              if (text.trim()) askAgent('claude-code')
            }
          }}
        />
        {mode === 'zarya' && (
          <>
            <button
              className={`zy-agentbar-effort${effort === 'max' ? ' zy-agentbar-effort--max' : ''}`}
              title={t('bar.effortHint', { level: t(EFFORT_TUNING[effort].labelKey) })}
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
              <span className="zy-agentbar-effort-label">{t(EFFORT_TUNING[effort].labelKey)}</span>
            </button>
            <button
              className="zy-agentbar-model"
              title={t('bar.modelHint', { model })}
              onClick={openLaunchPad}
            >
              <span className="zy-agentbar-model-name">{prettyModel(model)}</span>
              <span className="zy-agentbar-model-caret">▴</span>
            </button>
          </>
        )}
        <button
          className="zy-agentbar-send"
          title={t(isShell ? 'bar.run' : 'bar.send')}
          onClick={doAction}
        >
          <Icon name="send" size={16} />
        </button>
      </div>
      {micMenu}
    </div>
  )
})
