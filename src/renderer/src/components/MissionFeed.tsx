import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AiContentPart, BlockRecord } from '@shared/types'
import { onBus } from '@/lib/bus'
import { t, useLang } from '@/lib/i18n'
import { formatDuration, formatRelative, shortenPath } from '@/lib/ansi'
import { editPreview, type EditPreview } from '@shared/editDiff'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { setBarModeOf, setRaw, useUiStore } from '@/state/uiStore'
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
import { parseProgress, progressText } from '@shared/progress'
import { renderMarkdown } from '@/features/ai/markdown'
import { getTerminal } from '@/terminal/terminalRegistry'
import { Icon } from './Icon'
import { PixelIcon } from './PixelIcon'
import { AiCliLauncher, launchAiCli } from './AiCliLauncher'
import { useContextMenu, type MenuItem } from './ContextMenu'
import logoZarya from '@/assets/logo-zarya-64.png'
import './missionfeed.css'
import { ruleFor } from '@shared/allowRules'

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

/**
 * Лента панели. Обёрнута в memo: её родитель перерисовывается на каждое
 * движение мыши при перетаскивании, а лента — самое дорогое, что есть на
 * экране (сотни блоков, разметка, карточки инструментов). Свои данные она берёт
 * из сторов сама, поэтому пропуск чужой перерисовки ничего не «замораживает».
 */
export const MissionFeed = memo(function MissionFeed({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

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
    const btn = e.currentTarget as HTMLElement
    const r = btn.getBoundingClientRect()
    const folder = useSessionsStore.getState().sessions[sessionId]?.cwd
    void window.zarya.claudeCode.listSessions(folder).then((list) => {
      if (!list.length) {
        openMenu(
          r.left,
          r.bottom + 4,
          [{ label: t('feed.noPastSessions'), disabled: true }],
          btn
        )
        return
      }
      const SHOWN = 25
      const items: MenuItem[] = list.slice(0, SHOWN).map((s) => ({
        // Обрезать заголовок здесь больше не нужно — пункт меню сам укладывается
        // в одну строку с многоточием. Резать по 46 символам значило бы решать
        // за вёрстку, сколько влезет, и терять хвост даже в широком окне.
        label: s.summary || s.firstPrompt || t('feed.session'),
        hint: formatRelative(s.lastModified),
        onClick: () => {
          void window.zarya.claudeCode.sessionMessages(s.sessionId, folder).then((messages) => {
            useAiStore.getState().resumeClaudeSession({
              claudeSessionId: s.sessionId,
              title: s.summary || t('feed.claudeSession'),
              messages,
              cwd: folder,
              sessionId
            })
            setBarModeOf(sessionId, 'claude-code')
            setRaw(sessionId, false)
          })
        }
      }))
      // Молчаливое усечение читается как «это весь список»: у папки с активной
      // работой сессий бывают сотни, и человек уверенно ищет вчерашнюю среди
      // двадцати пяти самых свежих, не зная, что остальные просто не показаны.
      if (list.length > SHOWN) {
        items.push({ separator: true })
        items.push({
          label: t('feed.moreSessions', { n: list.length - SHOWN }),
          disabled: true
        })
      }
      openMenu(r.left, r.bottom + 4, items, btn)
    })
  }

  // Header ⚡ button → dropdown of installed AI CLIs (launch into «Терминал»).
  const openCliMenu = (e: React.MouseEvent): void => {
    const btn = e.currentTarget as HTMLElement
    const r = btn.getBoundingClientRect()
    void window.zarya.aiClis.detect().then((clis) => {
      const items = clis.map((c) => ({
        label: c.detected ? c.name : t('feed.notInstalled', { name: c.name }),
        hint: c.detected ? c.cmd : undefined,
        disabled: !c.detected,
        onClick: () => launchAiCli(c)
      }))
      openMenu(r.left, r.bottom + 4, items, btn)
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

  /*
   * Поиск по ленте.
   *
   * Ищем по тому, что на экране: блоки команд с их выводом, сообщения человека,
   * ответы агента и карточки инструментов. Прежняя строка поиска работала через
   * xterm, который в блочном режиме рендерится за экраном, — вводишь слово,
   * которое видишь, и не происходит ничего.
   *
   * Подсвечиваем элемент ЦЕЛИКОМ, а не слово внутри него. Ответ агента — это
   * отрендеренный markdown, и вставлять подсветку внутрь готовой разметки
   * значит трогать её после санитайзера; туда лезть нельзя, там же и защита от
   * инъекций. Найденный кусок на экране — глаз находит слово сам.
   */
  const feedQuery = useUiStore((s) => s.feedQuery)
  const feedStep = useUiStore((s) => s.feedStep)
  const searchHere = useUiStore((s) => s.searchOpenFor) === sessionId
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const clear = (): void => {
      root
        .querySelectorAll('.zy-mf-hit, .zy-mf-hit--now')
        .forEach((el) => el.classList.remove('zy-mf-hit', 'zy-mf-hit--now'))
    }
    clear()
    const q = searchHere ? feedQuery.trim().toLowerCase() : ''
    if (!q) {
      if (searchHere) useUiStore.getState().set({ feedHits: { count: 0, index: 0 } })
      return
    }
    const items = [...root.querySelectorAll('.zy-mf-block, .zy-mf-user, .zy-mf-answer, .zy-mf-tool')]
    const hits = items.filter((el) => (el.textContent ?? '').toLowerCase().includes(q))
    if (!hits.length) {
      useUiStore.getState().set({ feedHits: { count: 0, index: 0 } })
      return
    }
    // Шаги считаются по кругу: дойдя до последнего совпадения, «дальше» ведёт к
    // первому. Иначе кнопка молча перестаёт работать, и это читается поломкой.
    const index = ((feedStep % hits.length) + hits.length) % hits.length
    hits.forEach((el) => el.classList.add('zy-mf-hit'))
    const now = hits[index]
    now.classList.add('zy-mf-hit--now')
    now.scrollIntoView({ block: 'center' })
    useUiStore.getState().set({ feedHits: { count: hits.length, index } })
    return clear
  }, [feedQuery, feedStep, searchHere, blocks, conv?.messages, sessionId])

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
      useUiStore.getState().toast(t('common.copied'), 'success')
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
          {t('feed.mark')}
        </span>
        {cwd && (
          <span className="zy-mf-head-cwd" title={cwd}>
            {cwdShort}
          </span>
        )}
        <div className="zy-mf-head-spacer" />
        <button
          className="zy-mf-head-btn"
          title={t('feed.resumeHint')}
          onClick={openSessionsMenu}
        >
          <Icon name="history" size={13} />
        </button>
        <button
          className="zy-mf-head-btn"
          title={t('feed.launchHint')}
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
            {hasConv && conv && (
              <AgentSection conv={conv} cwd={cwdShort} afterBlocks={blocks.length > 0} />
            )}
            {conv?.queued && (
              <div className="zy-mf-queued">
                <Icon name="chevron-up" size={11} />
                <span className="zy-mf-queued-text">{t('feed.queued', { text: conv.queued })}</span>
                <span className="zy-mf-queued-hint">{t('feed.queuedHint')}</span>
              </div>
            )}
            {/* The prompt line means «your turn». It must not sit under a
                working agent claiming «готов · введите запрос» while the line
                right above it says the agent is answering — nor while a gate
                waits for a decision. */}
            {!busy && (
              <div className="zy-mf-ready">
                <span className="zy-mf-spark">
                  <PixelIcon name="star" />
                </span>
                <span className="zy-mf-cwd">{cwdShort || '~'}</span>
                <span className="zy-mf-chev">
                  <PixelIcon name="chevron-right" />
                </span>
                <span className="zy-mf-ready-text">{t('feed.ready')}</span>
              </div>
            )}
          </>
        )}
      </div>
      {cliMenu}
    </div>
  )
})

// ------------------------------------------------------------------- blocks

const ShellBlock = memo(function ShellBlock({
  block,
  branch,
  liveTail
}: {
  block: BlockRecord
  branch: string
  liveTail?: string
}): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const running = block.exitCode === undefined && block.endedAt === undefined
  const failed = block.exitCode !== undefined && block.exitCode !== 0
  const dur = block.endedAt ? block.endedAt - block.startedAt : 0
  // Пустой снимок не стирает то, что уже видно: пока команда идёт, движок
  // иногда отдаёт пустоту (экран прокрутился, блок ещё не начался), и лента
  // мигала бы пустым местом вместо вывода, который у неё есть.
  const output = liveTail ? liveTail : block.output
  const cwdShort = shortenPath(block.cwd || '', 30)
  // Загрузчик перерисовывает одну строку возвратом каретки: в терминале это
  // читается, а в ленте превращается в прыгающие цифры. Пока команда идёт,
  // достаём из хвоста то, что там сказано, и показываем спокойно — полосой.
  const progress = running ? parseProgress(output) : null

  return (
    <div className={`zy-mf-block${failed ? ' zy-mf-block--fail' : ''}`}>
      <div className="zy-mf-cmd">
        <span className="zy-mf-star">
          <PixelIcon name="star" />
        </span>
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
      {progress && (
        <div className="zy-mf-progress" title={progress.label ?? undefined}>
          <div className="zy-mf-progress-bar">
            {/* Ширина только при известном проценте: полоса «примерно на треть»
                у загрузки без процентов обещала бы знание, которого нет. */}
            <div
              className={`zy-mf-progress-fill${
                progress.percent === null ? ' zy-mf-progress-fill--unknown' : ''
              }`}
              style={progress.percent === null ? undefined : { width: `${progress.percent}%` }}
            />
          </div>
          <span className="zy-mf-progress-text">
            {progress.label ? `${progress.label} · ` : ''}
            {progressText(progress)}
          </span>
        </div>
      )}
      {output.trim() !== '' && <OutputLines text={output} failed={failed} />}
    </div>
  )
})

/** Friendly per-tool verbs (not shell-hardcoded for Read/Edit/Write/etc). */
function toolVerb(name: string): { want: string; run: string } {
  const n = name.toLowerCase()
  if (n === 'read' || n === 'grep' || n === 'glob' || n === 'ls')
    return { want: t('feed.wantsToRead'), run: t('feed.running.read') }
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit')
    return { want: t('feed.wantsToEdit'), run: t('feed.running.edit') }
  if (n === 'webfetch' || n === 'websearch')
    return { want: t('feed.wantsToFetch'), run: t('feed.running.fetch') }
  if (n === 'task' || n === 'agent')
    return { want: t('feed.wantsSubagent'), run: t('feed.running.subagent') }
  return { want: t('feed.wantsToRun'), run: t('feed.running.run') }
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

/**
 * Беседа для карточек инструментов — через контекст, а не пропсом.
 *
 * Пока агент печатает, объект беседы пересоздаётся десятки раз в секунду. Если
 * передавать его вниз пропсом, memo на сообщениях не значит НИЧЕГО: у каждого
 * сообщения меняется пропс, и лента перерисовывается целиком — вся разметка,
 * все строки вывода, все карточки. Через контекст перерисовываются только те,
 * кому беседа правда нужна, — карточки инструментов.
 *
 * Там же лежит индекс результатов. Раньше каждая карточка искала свой результат
 * перебором ВСЕХ сообщений: на длинном разговоре это квадрат, который растёт
 * ровно тогда, когда работать становится интереснее всего.
 */
interface FeedConv {
  conv: Conversation
  results: Map<string, Extract<AiContentPart, { type: 'tool_result' }>>
}
const FeedConvContext = createContext<FeedConv | null>(null)

function buildResultIndex(conv: Conversation): FeedConv['results'] {
  const map = new Map<string, Extract<AiContentPart, { type: 'tool_result' }>>()
  for (const m of conv.messages) {
    for (const p of m.content) {
      if (p.type === 'tool_result' && !map.has(p.toolUseId)) map.set(p.toolUseId, p)
    }
  }
  return map
}


function AgentSection({
  conv,
  cwd,
  afterBlocks
}: {
  conv: Conversation
  cwd: string
  /** Выше в ленте есть команды терминала — тогда границу видно и она нужна. */
  afterBlocks: boolean
}): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  // Индекс результатов пересчитывается при изменении сообщений — один проход на
  // перерисовку вместо перебора всей беседы в каждой карточке.
  const feed = useMemo<FeedConv>(
    () => ({ conv, results: buildResultIndex(conv) }),
    [conv]
  )
  // Признаки, от которых зависят СООБЩЕНИЯ, считаем здесь и отдаём значениями:
  // так их memo продолжает работать, пока меняется только последний ответ.
  const covered = useMemo(() => coveredToolUseIds(conv.subagents ?? {}), [conv.subagents])
  const gateId = nextGate(conv)?.id
  const interrupted = conv.interrupted
  return (
    <FeedConvContext.Provider value={feed}>
      {/*
        Полоса «ОТВЕТ АГЕНТА» — ГРАНИЦА между командами терминала и беседой, а
        не заголовок беседы. Раньше она рисовалась всегда: в панели, где команд
        нет вовсе, получалась линия во всю ширину, которая ничего не отделяет, —
        а в пустой беседе и вовсе пустая полоса под шапкой. Отделять нечего —
        значит и полосы нет.
      */}
      {afterBlocks && (
        <div className="zy-mf-divider">
          <span className="zy-mf-divider-line" />
          <span className="zy-mf-divider-label">
            <Icon name="bolt" size={11} />
            {t('feed.agentAnswer')}
          </span>
          <span className="zy-mf-divider-line" />
        </div>
      )}
      {conv.messages.map((m, i) => (
        <AgentMessage
          key={i}
          msg={m}
          cwd={cwd}
          covered={covered}
          gateId={gateId}
          interrupted={(interrupted ?? []).includes(i)}
        />
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
          id={t.id}
          name={t.name}
          input={t.input}
          title={t.title}
          isNextGate={gateId === t.id}
        />
      ))}
      <SubagentWave conv={conv} />
      {conv.streaming && conv.messages[conv.messages.length - 1]?.role === 'user' && (
        <div className="zy-mf-typing">
          <span className="zy-mf-spinner" />
          {t('feed.typing')}
        </div>
      )}
      {conv.error && <div className="zy-mf-errbanner">✗ {conv.error}</div>}
    </FeedConvContext.Provider>
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
function SubagentWave({
 conv }: { conv: Conversation }): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

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
        {allDone ? <Icon name="check" size={12} /> : <span className="zy-mf-spinner" aria-hidden />}
        <span className="zy-mf-wave-count">
          {w.done}/{w.total} {t(w.total === 1 ? 'feed.agentOne' : 'feed.agentMany')}
        </span>
        <span className="zy-mf-wave-sep">·</span>
        <span className="zy-mf-wave-time">{fmtElapsed(w.elapsedMs)}</span>
        {w.tokens > 0 && (
          <>
            <span className="zy-mf-wave-sep">·</span>
            <span className="zy-mf-wave-tokens" title={t('feed.tokensHint')}>
              ↓{fmtWaveTokens(w.tokens)} {t('feed.tokens')}
            </span>
          </>
        )}
      </div>
      {w.running.slice(0, 4).map((r) => (
        <div key={r.taskId} className="zy-mf-wave-row">
          <span className="zy-mf-wave-dot" />
          <span className="zy-mf-wave-what">{r.description ?? r.subagentType ?? t('feed.subagent')}</span>
          {r.lastTool && <span className="zy-mf-wave-tool">{r.lastTool}</span>}
        </div>
      ))}
      {w.running.length > 4 && (
        <div className="zy-mf-wave-row zy-mf-wave-row--more">{t('feed.andMore', { n: w.running.length - 4 })}</div>
      )}
    </div>
  )
}

const AgentMessage = memo(function AgentMessage({
  msg,
  cwd,
  covered,
  gateId,
  interrupted
}: {
  msg: Conversation['messages'][number]
  cwd: string
  /** Инструменты, о которых уже рассказала строка субагента выше. */
  covered: Set<string>
  /** Гейт, который одобрит голый Enter, — по нему карточка подсвечивается. */
  gateId?: string
  /** This user turn was cut off with Esc — no answer is coming for it. */
  interrupted?: boolean
}): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  if (msg.role === 'user') {
    const text = msg.content
      .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .filter((t) => !t.startsWith('[Контекст:'))
      .join('\n')
      .trim()
    const images = msg.content.filter(
      (p): p is Extract<AiContentPart, { type: 'image' }> => p.type === 'image'
    )
    // Ход из одних картинок — законный: «что тут не так?» со скриншотом.
    if (!text && !images.length) return null
    return (
      <div className="zy-mf-user">
        <span className="zy-mf-spark">
          <PixelIcon name="star" />
        </span>
        <span className="zy-mf-cwd">{cwd}</span>
        <span className="zy-mf-chev">
          <PixelIcon name="chevron-right" />
        </span>
        <span className="zy-mf-user-text">{text}</span>
        {interrupted && (
          <span
            className="zy-mf-user-cut"
            title={t('feed.interruptedHint')}
          >
            {t('feed.interrupted')}
          </span>
        )}
        {msg.ts != null && <span className="zy-mf-user-time">{fmtClock(msg.ts)}</span>}
        {images.length > 0 && (
          <div className="zy-mf-user-imgs">
            {images.map((img, i) => (
              <figure key={i} className="zy-mf-img">
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={img.name ?? t('feed.image', { n: i + 1 })}
                  loading="lazy"
                />
                <figcaption>
                  #{i + 1} · {img.width}×{img.height}
                  {img.name ? ` · ${img.name}` : ''}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    )
  }
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
              id={p.id}
              name={p.name}
              input={p.input}
              isNextGate={gateId === p.id}
            />
          )
        }
        return null
      })}
    </>
  )
})

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
/**
 * Правка файла на экране карточки.
 *
 * Цвет здесь тонкой чертой на краю строки, а не заливкой: красный в этом
 * интерфейсе значит «осторожно, необратимое», и заливать им каждую обычную
 * правку — значит стереть эту разницу. Черта различает убранное и добавленное
 * мгновенно и при этом ничего не обещает.
 *
 * Пока гейт ждёт решения, блок открыт и закрыть его нельзя: свёрнутая правка —
 * это снова «одобри то, чего не видишь». После решения (и при автопилоте, где
 * вопроса не было вовсе) он свёрнут, но заголовок с «−2 +4» виден всегда:
 * масштаб изменения читается, не открывая.
 */
function EditDiff({
  preview,
  pinned
}: {
  preview: EditPreview
  pinned: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(pinned)
  useEffect(() => {
    if (pinned) setOpen(true)
  }, [pinned])

  return (
    <div className="zy-mf-diff">
      <button
        type="button"
        className="zy-mf-diff-head"
        onClick={pinned ? undefined : () => setOpen((v) => !v)}
        title={pinned ? t('feed.diffPinned') : t(open ? 'feed.collapse' : 'feed.expand')}
      >
        {preview.removed > 0 && <span className="zy-mf-diff-minus">−{preview.removed}</span>}
        {preview.added > 0 && <span className="zy-mf-diff-plus">+{preview.added}</span>}
        {preview.kind === 'write' && (
          <span className="zy-mf-diff-write">{t('feed.diffWrite')}</span>
        )}
        {!!preview.chunks && preview.chunks > 1 && (
          <span className="zy-mf-diff-chunks">{t('feed.diffChunks', { n: preview.chunks })}</span>
        )}
        {/* Путь здесь не повторяем: он уже стоит строкой выше, в подписи самого
            инструмента («Edit · src/shared/fake.ts»). Второй раз — шум. */}
        {!pinned && (
          <span className="zy-mf-diff-caret">
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={11} />
          </span>
        )}
      </button>
      {open && (
        <div className="zy-mf-diff-body">
          {preview.lines.map((l, i) => (
            <div key={i} className={`zy-mf-diff-row zy-mf-diff-row--${l.kind}`}>
              <span className="zy-mf-diff-sign">
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <span className="zy-mf-diff-text">{l.text || ' '}</span>
            </div>
          ))}
          {preview.truncated && (
            <div className="zy-mf-diff-more">{t('feed.diffTruncated')}</div>
          )}
        </div>
      )}
    </div>
  )
}

const ToolCard = memo(function ToolCard({
  id,
  name,
  input: rawInput,
  title,
  isNextGate
}: {
  id: string
  name: string
  input: unknown
  /** Driver-supplied human title (ACP/Codex), preferred over a synthesized one. */
  title?: string
  /** This is the gate the Enter shortcut would approve (the first unsettled one). */
  isNextGate?: boolean
}): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  // Беседа — из контекста: пропсом она пересоздавалась бы каждый кусок потока и
  // отменяла бы memo у всех сообщений разом (см. FeedConvContext).
  const feed = useContext(FeedConvContext)
  const conv = feed?.conv
  const result0 = feed?.results.get(id)
  const startedAt = conv?.toolStartedAt?.[id]
  // Пока идёт — перерисовываемся раз в секунду, чтобы время шло. Считать не от
  // чего, кроме старта: вывод инструмента SDK отдаёт одним куском в конце.
  const ticking = !!startedAt && !result0
  const [, tickTool] = useState(0)
  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => tickTool((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [ticking])
  if (!conv) return null
  const pending = conv.pendingTools.find((t) => t.id === id)
  const result = feed.results.get(id)
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
  /*
   * Правка файла, которую просят одобрить (или уже сделали).
   *
   * Раньше на экране был только путь: человек одобрял изменение вслепую, хотя
   * для команды то же правило соблюдалось строго. Данные для показа приходят
   * всегда — и когда спрашивают, и когда автопилот выполнил молча, — поэтому
   * дифф виден в обоих случаях: развёрнутым, пока ждут решения, и свёрнутым
   * после, чтобы длинный ход не превращал ленту в простыню.
   */
  const edit = useMemo(() => editPreview(name, rawInput), [name, rawInput])

  let body: React.JSX.Element
  if (result) {
    const first = (result.content || '').split('\n')[0]
    body = result.isError ? (
      <div className="zy-mf-tool-denied">✗ {first || t('feed.denied')}</div>
    ) : (
      <div className="zy-mf-tool-done">✓ {first || 'exit 0'} — {t('feed.done')}</div>
    )
  } else if (pending && !pending.settled && pending.kind === 'question') {
    // AskUserQuestion — the bottom bar morphs into the selector; just point down.
    body = (
      <div className="zy-mf-tool-exec">
        <Icon name="chevron-down" size={12} />
        {t('feed.questionHint')}
      </div>
    )
  } else if (pending && !pending.settled) {
    // SECURITY: у части ACP-агентов нет разового разрешения — только «всегда».
    // Раньше кнопка всё равно говорила «ВЫПОЛНИТЬ», а согласие молча действовало
    // до конца сессии, и агент переставал спрашивать. Кнопка обязана называть
    // то, что делает: одобрение на один запуск и одобрение навсегда — разные
    // решения, и выбирать между ними должен человек, а не подстановка драйвера.
    const always = pending.allowAlwaysOnly === true
    const stop = pending.irreversible
    // Правило «до конца сессии» выдаётся не всякому вызову: необратимому — не
    // выдаётся вообще (иначе пол снимался бы через боковую дверь), и агентам,
    // у которых своё «разрешить всегда», второе такое же не нужно.
    const rule = always || stop ? null : ruleFor(pending.name, pending.input)
    body = (
      <div className="zy-mf-tool-actions">
        {stop && (
          /* Почему спросили при включённом автопилоте. Без этой строки вопрос
             читается как поломка тумблера, а не как защита от потери работы. */
          <div className="zy-mf-tool-stop">
            {t('feed.irreversible', { hit: stop.hit })}
          </div>
        )}
        {pending.mcpMark?.destructive && (
          /*
             Чем сервер пометил СВОЙ инструмент. Отдельной строкой от «пола» и
             другими словами: там наш список необратимого, здесь — заявление
             стороннего сервера. Мы за него не ручаемся и потому называем
             источник; молчать, зная, тоже нельзя — эта пометка уже у нас на
             руках, и человек решает без неё вслепую.
          */
          <div className="zy-mf-tool-mark">{t('feed.serverDestructive')}</div>
        )}
        <button
          className={`zy-mf-btn-run${always ? ' zy-mf-btn-run--always' : ''}`}
          title={
            always
              ? t('feed.alwaysOnlyHint')
              : undefined
          }
          onClick={() => void store.approveTool(conv.id, id)}
        >
          {t(always ? 'feed.approveAlways' : 'feed.approve')}
        </button>
        {rule && (
          <button
            className="zy-mf-btn-session"
            // Правило показывается ДОСЛОВНО ещё до нажатия: человек должен
            // видеть, что именно он разрешает, а не догадываться о ширине
            // разрешения по названию кнопки.
            title={t('feed.allowSessionHint', { rule })}
            onClick={() => void store.allowForSession(conv.id, id)}
          >
            {t('feed.allowSession')}
          </button>
        )}
        <button className="zy-mf-btn-deny" onClick={() => store.denyTool(conv.id, id)}>
          {t('feed.deny')}
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
        {/* Сколько уже идёт. Единственное, что мы честно знаем о команде,
            которую выполняет агент: её вывод придёт только в конце. */}
        {startedAt && (
          <span className="zy-mf-tool-elapsed">· {fmtElapsed(Date.now() - startedAt)}</span>
        )}
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
          <span className="zy-mf-tool-expand" title={t(expanded ? 'feed.collapse' : 'feed.expand')}>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
          </span>
        )}
        {view.mustShowFull && view.lines > 1 && (
          <span className="zy-mf-tool-lines" title={t('feed.fullCmd')}>
            {t('feed.lines', { n: view.lines })}
          </span>
        )}
        {/* «хочет выполнить» — только пока решение не принято. После одобрения
            команда УЖЕ идёт, и та же подпись сообщала бы о выборе, которого
            больше нет; после результата — тем более. */}
        {!view.mustShowFull && !result && (pending ? !pending.settled : true) && (
          <span className="zy-mf-tool-note">{verb.want}</span>
        )}
      </div>
      {(view.mustShowFull || (open && view.isLong)) && (
        <pre className={`zy-mf-tool-full${view.mustShowFull ? ' zy-mf-tool-full--pinned' : ''}`}>
          {cmd}
        </pre>
      )}
      {edit && <EditDiff preview={edit} pinned={awaiting} />}
      {body}
    </div>
  )
})

// -------------------------------------------------------------------- empty

function EmptyHero({
 sessionId }: { sessionId: string }): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  return (
    <div className="zy-mf-empty">
      <div className="zy-mf-empty-mark">
        <img
          src={logoZarya}
          width={44}
          height={44}
          style={{ imageRendering: 'pixelated' }}
          alt=""
        />
      </div>
      <div className="zy-mf-empty-title">{t('feed.heroTitle')}</div>
      <div className="zy-mf-empty-hint">{t('feed.heroSub')}</div>
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
        title: s.summary || t('feed.claudeSession'),
        messages,
        cwd,
        sessionId
      })
      setBarModeOf(sessionId, 'claude-code')
      setRaw(sessionId, false)
    })
  }

  return (
    <div className="zy-resume">
      <div className="zy-resume-label">{t('feed.recentClaudeLower')}</div>
      <div className="zy-resume-list">
        {sessions.map((s) => (
          <button key={s.sessionId} className="zy-resume-item" onClick={() => resume(s)}>
            <Icon name="history" size={13} />
            <span className="zy-resume-summary">{(s.summary || t('feed.session')).slice(0, 52)}</span>
            <span className="zy-resume-time">{formatRelative(s.lastModified)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// QA hook: seed the feed with the design's sample mission so the offscreen
// harness can screenshot a populated 1:1 view. Harmless in production.
;(window as unknown as { __zaryaSeedMission?: () => void }).__zaryaSeedMission = () => {
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
      output: 'On branch main\n3 files changed: src/store.ts, App.tsx, package.json',
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
        "src/store.ts(42,7): error TS2531: Object is possibly 'null'.\nsrc/store.ts(58,3): error TS2532: Object is possibly 'undefined'.\n2 type errors · build failed",
      outputTruncated: false
    }
  ])
  const store = useAiStore.getState()
  const convId = store.newConversation({ sessionId: sid, title: 'Demo mission' })
  useAiStore.setState((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === convId
        ? {
            ...c,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'build the project and fix the type errors' }]
              },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: 'Running the build… found **2 type errors** in `src/store.ts` — the value can be `null`. Preparing a patch.\n\n```diff\n--- a/src/store.ts\n+++ b/src/store.ts\n- const u = store.get(id).user\n+ const u = store.get(id)?.user ?? null\n```'
                  },
                  {
                    type: 'tool_use',
                    id: 'seed-tu',
                    name: 'run_command',
                    input: { command: 'pnpm build' }
                  }
                ]
              }
            ],
            pendingTools: [
              {
                id: 'seed-tu',
                name: 'run_command',
                input: { command: 'pnpm build' },
                autoApproved: false,
                settled: false
              }
            ]
          }
        : c
    )
  }))
}
