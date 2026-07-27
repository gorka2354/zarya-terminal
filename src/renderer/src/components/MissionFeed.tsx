import { useEffect, useRef, useState } from 'react'
import type { AiContentPart, BlockRecord } from '@shared/types'
import { onBus } from '@/lib/bus'
import { formatDuration, formatRelative, shortenPath } from '@/lib/ansi'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { convForSession, useAiStore, type Conversation } from '@/features/ai/aiStore'
import {
  feedIsBusy,
  gateLabel,
  gateView,
  nextGate,
  orphanGates,
  toolLabel
} from '@/features/ai/gates'
import {
  coveredToolUseIds,
  fmtElapsed,
  fmtTokens as fmtWaveTokens,
  summarizeWave
} from '@/features/ai/subagents'
import { renderMarkdown } from '@/features/ai/markdown'
import { getTerminal } from '@/terminal/terminalRegistry'
import { Icon } from './Icon'
import { PixelIcon } from './PixelIcon'
import { AiCliLauncher, launchAiCli } from './AiCliLauncher'
import { useContextMenu } from './ContextMenu'
import logoZarya from '@/assets/logo-zarya-64.png'
import './missionfeed.css'

/**
 * The mission feed — Zarya's centre stage, a 1:1 port of the design's unified
 * command/agent scroll. Completed shell commands render as Warp-style blocks
 * (prompt line + output + exit pill, red rail on failure); the agent's turn
 * renders inline below an «ОТВЕТ АГЕНТА» divider (echo → answer → patch card →
 * tool-call card). Data is real: shell blocks come from {@link useBlocksStore}
 * (fed by the offscreen xterm engine), the conversation from {@link useAiStore}.
 */
// Stable empty reference: a fresh `[]` in the selector makes zustand see a new
// value every render → infinite re-render loop (React #185).
const NO_BLOCKS: BlockRecord[] = []

/** HH:MM for the right-aligned send time on a user turn. */
function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MissionFeed({ sessionId }: { sessionId: string }): React.JSX.Element {
  const blocks = useBlocksStore((s) => s.bySession[sessionId] ?? NO_BLOCKS)
  const cwd = useSessionsStore((s) => s.sessions[sessionId]?.cwd ?? '')
  // Each terminal shows its OWN agent conversation (bound by sessionId).
  const conv = useAiStore((s) => convForSession(s, sessionId))
  const [branch, setBranch] = useState('')
  const [liveTail, setLiveTail] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const { menu: cliMenu, open: openMenu } = useContextMenu()

  // Header ↺ button → past Claude Code sessions for THIS folder (resume one).
  const openSessionsMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const folder = useSessionsStore.getState().sessions[sessionId]?.cwd
    void window.zarya.claudeCode.listSessions(folder).then((list) => {
      if (!list.length) {
        openMenu(r.left, r.bottom + 4, [
          { label: 'Нет прошлых сессий Claude в этой папке', disabled: true }
        ])
        return
      }
      const items = list.slice(0, 25).map((s) => ({
        label: (s.summary || s.firstPrompt || 'Сессия').slice(0, 46),
        hint: formatRelative(s.lastModified),
        onClick: () => {
          void window.zarya.claudeCode.sessionMessages(s.sessionId, folder).then((messages) => {
            useAiStore.getState().resumeClaudeSession({
              claudeSessionId: s.sessionId,
              title: s.summary || 'Claude сессия',
              messages,
              cwd: folder,
              sessionId
            })
            useUiStore.getState().set({ barMode: 'claude-code', rawTerminal: false })
          })
        }
      }))
      openMenu(r.left, r.bottom + 4, items)
    })
  }

  // Header ⚡ button → dropdown of installed AI CLIs (launch into «Терминал»).
  const openCliMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    void window.zarya.aiClis.detect().then((clis) => {
      const items = clis.map((c) => ({
        label: c.detected ? c.name : `${c.name} · не установлен`,
        hint: c.detected ? c.cmd : undefined,
        disabled: !c.detected,
        onClick: () => launchAiCli(c)
      }))
      openMenu(r.left, r.bottom + 4, items)
    })
  }

  // Current git branch for the prompt line — refreshed when the cwd changes or
  // a command finishes (a checkout/commit could have moved the branch).
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      if (!cwd) return setBranch('')
      void window.zarya.git.status(cwd).then((g) => {
        if (alive) setBranch(g?.branch ?? '')
      })
    }
    refresh()
    const unsub = onBus('block:finished', ({ sessionId: sid }) => {
      if (sid === sessionId) refresh()
    })
    const unsubCwd = onBus('terminal:cwd-changed', ({ sessionId: sid }) => {
      if (sid === sessionId) refresh()
    })
    return () => {
      alive = false
      unsub()
      unsubCwd()
    }
  }, [cwd, sessionId])

  // Poll the live output tail while a command is running.
  const running = blocks.find((b) => b.exitCode === undefined && b.endedAt === undefined)
  const runningId = running?.id
  useEffect(() => {
    if (!runningId) {
      setLiveTail('')
      return
    }
    let timer = 0
    const tick = (): void => {
      const engine = getTerminal(sessionId)?.engine
      if (engine) setLiveTail(engine.snapshotOutput())
      timer = window.setTimeout(tick, 160)
    }
    tick()
    return () => clearTimeout(timer)
  }, [runningId, sessionId])

  // «Занят» = агент отвечает, крутится инструмент, ждёт решения по гейту или в
  // терминале идёт команда. Пока так — строка приглашения молчит.
  const busy = feedIsBusy(conv, !!runningId)
  const stickRef = useRef(true)
  // SECURITY: a gate awaiting a decision is the one thing the feed may yank the
  // view for. Enter approves it from anywhere on the window, so a card out of
  // sight would be a blind yes.
  const waitingGateId = conv ? nextGate(conv)?.id : undefined
  const waitingCount = conv
    ? conv.pendingTools.filter((t) => !t.settled && t.kind !== 'question').length
    : 0

  // Follow new content only while the user is already near the bottom — so
  // scrolling up to read during a long turn isn't yanked back down. Suspended
  // entirely while a gate waits: the anchor effect below owns the viewport then,
  // and a tool_result landing under the card would otherwise scroll the gate that
  // Enter targets off screen, leaving a different card under the keystroke.
  useEffect(() => {
    if (waitingGateId) return
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks, conv?.messages, liveTail, waitingGateId])

  // Anchor to the waiting card — NOT to the end of the feed: with parallel tool
  // calls the bottom card is not the one Enter acts on.
  useEffect(() => {
    const el = scrollRef.current
    if (!waitingGateId) {
      // Gate cleared — hand following back, judged by the ACTUAL position. Not an
      // unconditional `true` (someone who scrolled up to read would be yanked
      // down), and not a bare return either: leaving stick pinned false froze the
      // feed for the rest of the session, so the output of the command just
      // approved never came into view.
      if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
      return
    }
    stickRef.current = false
    const card = el?.querySelector<HTMLElement>(`[data-gate-id="${CSS.escape(waitingGateId)}"]`)
    // `block: 'start'` — the head of the command must be on screen, not its tail.
    if (card) card.scrollIntoView({ block: 'start' })
    else if (el) el.scrollTop = el.scrollHeight
  }, [waitingGateId, waitingCount])

  // Patch-card action buttons (Скопировать / Вставить / Выполнить), wired via
  // event delegation exactly like the AI panel.
  const onFeedClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    const btn = target.closest<HTMLElement>('[data-code-action]')
    if (!btn) {
      // Links in agent-rendered markdown must leave the app, never navigate the
      // top frame: a RELATIVE href resolves against our own file: URL and would
      // load an attacker-supplied local page with the full preload API. Main
      // blocks that too, but intercepting here is what makes real links work.
      const link = target.closest<HTMLAnchorElement>('a[href]')
      if (link) {
        e.preventDefault()
        window.zarya.app.openExternal(link.getAttribute('href') ?? '')
      }
      return
    }
    const wrapper = btn.closest<HTMLElement>('.zy-md-code')
    const encoded = wrapper?.getAttribute('data-code') ?? ''
    const code = encoded ? decodeURIComponent(encoded) : ''
    if (!code) return
    const action = btn.dataset.codeAction
    if (action === 'copy') {
      void navigator.clipboard.writeText(code)
      useUiStore.getState().toast('Скопировано', 'success')
      return
    }
    if (action === 'insert') {
      window.zarya.pty.write(sessionId, code.replace(/\r?\n$/, ''))
    } else if (action === 'run') {
      window.zarya.pty.write(sessionId, code + '\r')
    }
  }

  const hasConv = !!conv && conv.messages.length > 0
  const isEmpty = blocks.length === 0 && !hasConv
  const cwdShort = shortenPath(cwd || '', 34)

  return (
    <div className="zy-mf">
      <div className="zy-mf-head">
        <span className="zy-mf-head-mark">
          <Icon name="star" size={12} />
          CLI-АГЕНТ · ЗАРЯ
        </span>
        {cwd && (
          <span className="zy-mf-head-cwd" title={cwd}>
            {cwdShort}
          </span>
        )}
        <div className="zy-mf-head-spacer" />
        <button
          className="zy-mf-head-btn"
          title="Сессии Claude в этой папке — возобновить прошлую"
          onClick={openSessionsMenu}
        >
          <Icon name="history" size={13} />
        </button>
        <button
          className="zy-mf-head-btn"
          title="Запустить ИИ-агента в терминале (Claude Code, Codex, Gemini…)"
          onClick={openCliMenu}
        >
          <Icon name="bolt" size={13} />
        </button>
      </div>

      <div
        className="zy-mf-scroll"
        ref={scrollRef}
        onClick={onFeedClick}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
        }}
      >
        {isEmpty ? (
          <EmptyHero sessionId={sessionId} />
        ) : (
          <>
            {blocks.map((b) => (
              <ShellBlock
                key={b.id}
                block={b}
                branch={branch}
                liveTail={b.id === runningId ? liveTail : undefined}
              />
            ))}
            {hasConv && conv && <AgentSection conv={conv} cwd={cwdShort} />}
            {conv?.queued && (
              <div className="zy-mf-queued">
                <Icon name="chevron-up" size={11} />
                <span className="zy-mf-queued-text">в очереди: {conv.queued}</span>
                <span className="zy-mf-queued-hint">↑ править · Esc прервать</span>
              </div>
            )}
            {/* The prompt line means «your turn». It must not sit under a
                working agent claiming «готов · введите запрос» while the line
                right above it says the agent is answering — nor while a gate
                waits for a decision. */}
            {!busy && (
              <div className="zy-mf-ready">
                <span className="zy-mf-spark"><PixelIcon name="star" /></span>
                <span className="zy-mf-cwd">{cwdShort || '~'}</span>
                <span className="zy-mf-chev"><PixelIcon name="chevron-right" /></span>
                <span className="zy-mf-ready-text">готов · введите запрос в строку ниже ↓</span>
              </div>
            )}
          </>
        )}
      </div>
      {cliMenu}
    </div>
  )
}

// ------------------------------------------------------------------- blocks

function ShellBlock({
  block,
  branch,
  liveTail
}: {
  block: BlockRecord
  branch: string
  liveTail?: string
}): React.JSX.Element {
  const running = block.exitCode === undefined && block.endedAt === undefined
  const failed = block.exitCode !== undefined && block.exitCode !== 0
  const dur = block.endedAt ? block.endedAt - block.startedAt : 0
  const output = liveTail !== undefined ? liveTail : block.output
  const cwdShort = shortenPath(block.cwd || '', 30)

  return (
    <div className={`zy-mf-block${failed ? ' zy-mf-block--fail' : ''}`}>
      <div className="zy-mf-cmd">
        <span className="zy-mf-star"><PixelIcon name="star" /></span>
        <span className="zy-mf-cwd">{cwdShort}</span>
        {branch && (
          <span className="zy-mf-git">
            git:(<span className="zy-mf-branch">{branch}</span>)
          </span>
        )}
        <span className="zy-mf-dollar">$ {block.command || '…'}</span>
        <span
          className={`zy-mf-pill ${
            running ? 'zy-mf-pill--run' : failed ? 'zy-mf-pill--fail' : 'zy-mf-pill--ok'
          }`}
        >
          {running ? (
            '⋯'
          ) : (
            <>
              <PixelIcon name={failed ? 'cross' : 'check'} className="zy-mf-pill-glyph" />
              {`${block.exitCode ?? 0} · ${formatDuration(dur)}`}
            </>
          )}
        </span>
      </div>
      {output.trim() !== '' && <OutputLines text={output} failed={failed} />}
    </div>
  )
}

/** Friendly per-tool verbs (not shell-hardcoded for Read/Edit/Write/etc). */
function toolVerb(name: string): { want: string; run: string } {
  const n = name.toLowerCase()
  if (n === 'read' || n === 'grep' || n === 'glob' || n === 'ls')
    return { want: 'агент хочет прочитать', run: 'читает…' }
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit')
    return { want: 'агент хочет изменить файл', run: 'применяет правку…' }
  if (n === 'webfetch' || n === 'websearch')
    return { want: 'агент хочет в сеть', run: 'запрос в сеть…' }
  if (n === 'task' || n === 'agent') return { want: 'агент хочет запустить субагента', run: 'субагент работает…' }
  return { want: 'агент хочет выполнить', run: 'выполняется…' }
}

const ERR_RE = /error|ошибк|failed|exception|not found|cannot|no such|traceback/i

function OutputLines({ text, failed }: { text: string; failed: boolean }): React.JSX.Element {
  // Only render the tail — long output is capped upstream, but keep the DOM light.
  const all = text.split('\n')
  const lines = all.length > 220 ? all.slice(all.length - 220) : all
  return (
    <div className="zy-mf-out">
      {lines.map((ln, i) => (
        <div key={i} className={failed && ERR_RE.test(ln) ? 'zy-mf-out-err' : undefined}>
          {ln || ' '}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- agent

function AgentSection({ conv, cwd }: { conv: Conversation; cwd: string }): React.JSX.Element {
  return (
    <>
      <div className="zy-mf-divider">
        <span className="zy-mf-divider-line" />
        <span className="zy-mf-divider-label">
          <Icon name="bolt" size={11} />
          ОТВЕТ АГЕНТА
        </span>
        <span className="zy-mf-divider-line" />
      </div>
      {conv.messages.map((m, i) => (
        <AgentMessage key={i} msg={m} conv={conv} cwd={cwd} interrupted={(conv.interrupted ?? []).includes(i)} />
      ))}
      {/*
        Gates that no message describes. Claude Code announces a tool as a
        `tool_use` block, so its card is rendered inside the message above —
        but Codex and the ACP engines only raise a `permission` event. Those
        gates used to be INVISIBLE while Enter still approved them, i.e. a
        blind "yes" to a command the user never saw. Render them here.
      */}
      {orphanGates(conv).map((t) => (
        <ToolCard
          key={t.id}
          conv={conv}
          id={t.id}
          name={t.name}
          input={t.input}
          title={t.title}
          isNextGate={nextGate(conv)?.id === t.id}
        />
      ))}
      <SubagentWave conv={conv} />
      {conv.streaming && conv.messages[conv.messages.length - 1]?.role === 'user' && (
        <div className="zy-mf-typing">
          <span className="zy-mf-spinner" />
          агент отвечает…
        </div>
      )}
      {conv.error && <div className="zy-mf-errbanner">✗ {conv.error}</div>}
    </>
  )
}

/**
 * The subagent wave — one line instead of a stack of identical cards.
 *
 * Claude Code spawns these for research and parallel work, and reports each
 * one's cost itself; every figure here is the SDK's own. Without this the feed
 * showed N indistinguishable «субагент работает…» spinners and no way to tell
 * how many there were, how long they had run, or what they cost.
 */
function SubagentWave({ conv }: { conv: Conversation }): React.JSX.Element | null {
  const runs = conv.subagents
  // Re-render on a timer so the elapsed time ticks between SDK updates.
  const [, tick] = useState(0)
  const active = !!runs && Object.keys(runs).length > 0
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => tick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  if (!runs || !active) return null

  const w = summarizeWave(runs, Date.now())
  const allDone = w.done === w.total
  return (
    <div className={`zy-mf-wave${allDone ? ' zy-mf-wave--done' : ''}`}>
      <div className="zy-mf-wave-head">
        {allDone ? (
          <Icon name="check" size={12} />
        ) : (
          <span className="zy-mf-spinner" aria-hidden />
        )}
        <span className="zy-mf-wave-count">
          {w.done}/{w.total} {w.total === 1 ? 'агент' : 'агентов'}
        </span>
        <span className="zy-mf-wave-sep">·</span>
        <span className="zy-mf-wave-time">{fmtElapsed(w.elapsedMs)}</span>
        {w.tokens > 0 && (
          <>
            <span className="zy-mf-wave-sep">·</span>
            <span className="zy-mf-wave-tokens" title="Токены, посчитанные самим Claude Code">
              ↓{fmtWaveTokens(w.tokens)} токенов
            </span>
          </>
        )}
      </div>
      {w.running.slice(0, 4).map((r) => (
        <div key={r.taskId} className="zy-mf-wave-row">
          <span className="zy-mf-wave-dot" />
          <span className="zy-mf-wave-what">{r.description ?? r.subagentType ?? 'субагент'}</span>
          {r.lastTool && <span className="zy-mf-wave-tool">{r.lastTool}</span>}
        </div>
      ))}
      {w.running.length > 4 && (
        <div className="zy-mf-wave-row zy-mf-wave-row--more">
          …и ещё {w.running.length - 4}
        </div>
      )}
    </div>
  )
}

function AgentMessage({
  msg,
  conv,
  cwd,
  interrupted
}: {
  msg: Conversation['messages'][number]
  conv: Conversation
  cwd: string
  /** This user turn was cut off with Esc — no answer is coming for it. */
  interrupted?: boolean
}): React.JSX.Element | null {
  if (msg.role === 'user') {
    const text = msg.content
      .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .filter((t) => !t.startsWith('[Контекст:'))
      .join('\n')
      .trim()
    if (!text) return null
    return (
      <div className="zy-mf-user">
        <span className="zy-mf-spark"><PixelIcon name="star" /></span>
        <span className="zy-mf-cwd">{cwd}</span>
        <span className="zy-mf-chev"><PixelIcon name="chevron-right" /></span>
        <span className="zy-mf-user-text">{text}</span>
        {interrupted && (
          <span className="zy-mf-user-cut" title="Ход прерван по Esc. Ответа не будет, но агент увидит это сообщение при продолжении беседы">
            прервано
          </span>
        )}
        {msg.ts != null && <span className="zy-mf-user-time">{fmtClock(msg.ts)}</span>}
      </div>
    )
  }
  // Built once per message, not once per tool_use block inside it.
  const covered = coveredToolUseIds(conv.subagents ?? {})
  return (
    <>
      {msg.content.map((p, i) => {
        if (p.type === 'text') {
          return p.text.trim() ? (
            <div
              key={i}
              className="zy-mf-answer zy-md"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }}
            />
          ) : null
        }
        if (p.type === 'tool_use') {
          // A subagent's «Agent» card would say only «субагент работает…» while
          // the wave line above already names the task, its runtime and its
          // cost. Showing both is the same information twice, the useless copy
          // on top.
          if (covered.has(p.id)) return null
          return (
            <ToolCard
              key={i}
              conv={conv}
              id={p.id}
              name={p.name}
              input={p.input}
              isNextGate={nextGate(conv)?.id === p.id}
            />
          )
        }
        return null
      })}
    </>
  )
}

function findToolResult(
  conv: Conversation,
  toolUseId: string
): Extract<AiContentPart, { type: 'tool_result' }> | undefined {
  for (const m of conv.messages) {
    for (const p of m.content) {
      if (p.type === 'tool_result' && p.toolUseId === toolUseId) return p
    }
  }
  return undefined
}

/**
 * One tool gate. Driven by (id, name, input) rather than by a `tool_use` block,
 * because only the Claude Code driver emits those: Codex and the ACP engines
 * (Gemini/Kimi/Qwen) announce a pending permission as a bare event, so their
 * gates had NO card at all — yet Enter still approved them. Same card now
 * renders for every engine.
 */
function ToolCard({
  conv,
  id,
  name,
  input: rawInput,
  title,
  isNextGate
}: {
  conv: Conversation
  id: string
  name: string
  input: unknown
  /** Driver-supplied human title (ACP/Codex), preferred over a synthesized one. */
  title?: string
  /** This is the gate the Enter shortcut would approve (the first unsettled one). */
  isNextGate?: boolean
}): React.JSX.Element {
  const pending = conv.pendingTools.find((t) => t.id === id)
  const result = findToolResult(conv, id)
  // Label from the pending gate when there is one: it carries `displayName`, which
  // is the ONLY human description ACP engines send (their `title` is undefined and
  // their input has no command/path). Labelling from the props alone decayed those
  // gates to a bare «Bash» / «Edit» — a card describing nothing, in the surface
  // that is always on screen.
  const cmd = pending ? gateLabel(pending) : toolLabel(name, rawInput, title)
  const store = useAiStore.getState()

  const verb = toolVerb(name)
  // Long / multi-line commands fold to a single line (CLI-style), expand on click —
  // EXCEPT while the gate awaits a decision, when the full text is pinned open in a
  // block of its own (the header line alone is too narrow to be trusted with it).
  const awaiting = !!pending && !pending.settled && pending.kind !== 'question'
  const view = gateView(cmd, awaiting)
  const [expanded, setExpanded] = useState(false)
  const open = view.mustShowFull || expanded
  const canFold = view.isLong && !view.mustShowFull

  let body: React.JSX.Element
  if (result) {
    const first = (result.content || '').split('\n')[0]
    body = result.isError ? (
      <div className="zy-mf-tool-denied">✗ {first || 'отклонено оператором'}</div>
    ) : (
      <div className="zy-mf-tool-done">✓ {first || 'exit 0'} — готово</div>
    )
  } else if (pending && !pending.settled && pending.kind === 'question') {
    // AskUserQuestion — the bottom bar morphs into the selector; just point down.
    body = (
      <div className="zy-mf-tool-exec">
        <Icon name="chevron-down" size={12} />
        агент задал вопрос — выберите вариант в строке ниже
      </div>
    )
  } else if (pending && !pending.settled) {
    body = (
      <div className="zy-mf-tool-actions">
        <button className="zy-mf-btn-run" onClick={() => void store.approveTool(conv.id, id)}>
          ВЫПОЛНИТЬ
        </button>
        <button className="zy-mf-btn-deny" onClick={() => store.denyTool(conv.id, id)}>
          ОТКЛОНИТЬ
        </button>
        {/* Enter/Esc act on the FIRST unsettled gate, so only that card may claim
            them — otherwise a second waiting card invites a keystroke that lands
            somewhere else. */}
        {isNextGate && <span className="zy-mf-tool-kbd">Enter · Esc</span>}
      </div>
    )
  } else {
    body = (
      <div className="zy-mf-tool-exec">
        <span className="zy-mf-spinner" />
        {verb.run}
      </div>
    )
  }

  return (
    <div className="zy-mf-tool" data-gate-id={awaiting ? id : undefined}>
      <div
        className={`zy-mf-tool-head${canFold ? ' zy-mf-tool-head--clickable' : ''}`}
        onClick={canFold ? () => setExpanded((v) => !v) : undefined}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)">
          <path d="M8 5.5l11 6.5-11 6.5z" />
        </svg>
        {/* While pinned the command lives in the <pre> below — repeating it here
            would only re-introduce the ellipsised copy the pin exists to avoid. */}
        {view.mustShowFull ? (
          <span className="zy-mf-tool-ask">{verb.want}</span>
        ) : (
          <code className="zy-mf-tool-cmd">{open ? view.firstLine : view.label}</code>
        )}
        {canFold && (
          <span className="zy-mf-tool-expand" title={expanded ? 'Свернуть' : 'Развернуть команду'}>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
          </span>
        )}
        {view.mustShowFull && view.lines > 1 && (
          <span className="zy-mf-tool-lines" title="Команда показана целиком, без сворачивания">
            {view.lines} стр.
          </span>
        )}
        {!view.mustShowFull && <span className="zy-mf-tool-note">{verb.want}</span>}
      </div>
      {(view.mustShowFull || (open && view.isLong)) && (
        <pre
          className={`zy-mf-tool-full${view.mustShowFull ? ' zy-mf-tool-full--pinned' : ''}`}
        >
          {cmd}
        </pre>
      )}
      {body}
    </div>
  )
}

// -------------------------------------------------------------------- empty

function EmptyHero({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <div className="zy-mf-empty">
      <div className="zy-mf-empty-mark">
        <img src={logoZarya} width={44} height={44} style={{ imageRendering: 'pixelated' }} alt="" />
      </div>
      <div className="zy-mf-empty-title">Борт готов к старту</div>
      <div className="zy-mf-empty-hint">
        введите команду или запрос агенту в строку ниже ↓
      </div>
      <AiCliLauncher />
      <ClaudeResumeList sessionId={sessionId} />
    </div>
  )
}

/**
 * Recent Claude Code sessions for THIS folder, shown right in the agent window
 * so you pick one to resume instead of always starting a new chat — the CLI's
 * `--resume`, but visual and folder-scoped.
 */
function ClaudeResumeList({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [sessions, setSessions] = useState<
    Array<{ sessionId: string; summary: string; lastModified: number; gitBranch?: string }>
  >([])
  const cwd = useSessionsStore((s) => s.sessions[sessionId]?.cwd)

  useEffect(() => {
    let alive = true
    void window.zarya.claudeCode.listSessions(cwd).then((list) => {
      if (alive) setSessions(list.slice(0, 6))
    })
    return () => {
      alive = false
    }
  }, [cwd])

  if (!sessions.length) return null

  const resume = (s: { sessionId: string; summary: string }): void => {
    void window.zarya.claudeCode.sessionMessages(s.sessionId, cwd).then((messages) => {
      useAiStore.getState().resumeClaudeSession({
        claudeSessionId: s.sessionId,
        title: s.summary || 'Claude сессия',
        messages,
        cwd,
        sessionId
      })
      useUiStore.getState().set({ barMode: 'claude-code', rawTerminal: false })
    })
  }

  return (
    <div className="zy-resume">
      <div className="zy-resume-label">недавние сессии Claude в этой папке</div>
      <div className="zy-resume-list">
        {sessions.map((s) => (
          <button key={s.sessionId} className="zy-resume-item" onClick={() => resume(s)}>
            <Icon name="history" size={13} />
            <span className="zy-resume-summary">{(s.summary || 'Сессия').slice(0, 52)}</span>
            <span className="zy-resume-time">{formatRelative(s.lastModified)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// QA hook: seed the feed with the design's sample mission so the offscreen
// harness can screenshot a populated 1:1 view. Harmless in production.
;(
  window as unknown as { __zaryaSeedMission?: () => void }
).__zaryaSeedMission = () => {
  const sid = useSessionsStore.getState().activeSessionId()
  if (!sid) return
  const t = Date.now()
  useBlocksStore.getState().setBlocks(sid, [
    {
      id: 'seed-1',
      sessionId: sid,
      command: 'git status',
      cwd: '~/code/zarya-web',
      startedAt: t - 6000,
      endedAt: t - 5960,
      exitCode: 0,
      output: 'On branch main\nизменено 3 файла: src/store.ts, App.tsx, package.json',
      outputTruncated: false
    },
    {
      id: 'seed-2',
      sessionId: sid,
      command: 'pnpm build',
      cwd: '~/code/zarya-web',
      startedAt: t - 4000,
      endedAt: t - 3966,
      exitCode: 1,
      output:
        "src/store.ts(42,7): error TS2531: Object is possibly 'null'.\nsrc/store.ts(58,3): error TS2532: Object is possibly 'undefined'.\n2 ошибки типов · сборка прервана",
      outputTruncated: false
    }
  ])
  const store = useAiStore.getState()
  const convId = store.newConversation({ sessionId: sid, title: 'Демо-миссия' })
  useAiStore.setState((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === convId
        ? {
            ...c,
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'собери проект и почини ошибки типов' }] },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text:
                      'Запускаю сборку… нашёл **2 ошибки типов** в `src/store.ts` — значение может быть `null`. Готовлю патч.\n\n```diff\n--- a/src/store.ts\n+++ b/src/store.ts\n- const u = store.get(id).user\n+ const u = store.get(id)?.user ?? null\n```'
                  },
                  { type: 'tool_use', id: 'seed-tu', name: 'run_command', input: { command: 'pnpm build' } }
                ]
              }
            ],
            pendingTools: [
              { id: 'seed-tu', name: 'run_command', input: { command: 'pnpm build' }, autoApproved: false, settled: false }
            ]
          }
        : c
    )
  }))
}
