import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AiContentPart, BlockRecord } from '@shared/types'
import { onBus } from '@/lib/bus'
import { currentLang, t, useLang } from '@/lib/i18n'
import { paneDraft } from '@/state/paneDrafts'
import { toMarkdown, transcriptFileName } from '@shared/transcript'
import { formatDuration, formatRelative, shortenPath } from '@/lib/ansi'
import { editPreview, lineDiff, type EditPreview } from '@shared/editDiff'
import { listChanges, type ChangedFile } from '@shared/changes'
import { matchTouched, touchedSince } from '@shared/touched'
import { rewindPlan, type FileFacts, type RewindMark, type SeenFile } from '@shared/rewindPlan'
import { canRewindTurn } from '@shared/rewindGate'
import { useEditorStore } from '@/features/editor/editorStore'
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
  runLabel,
  summarizeWave
} from '@/features/ai/subagents'
import { parseProgress, progressText } from '@shared/progress'
import { planSummary } from '@shared/agentPlan'
import { renderMarkdown } from '@/features/ai/markdown'
import { getTerminal } from '@/terminal/terminalRegistry'
import { sendCodeToTerminal } from '@/features/ai/pasteGuard'
import { Icon } from './Icon'
import { PixelIcon } from './PixelIcon'
import { AiCliLauncher, launchAiCli } from './AiCliLauncher'
import { useContextMenu, type MenuItem } from './ContextMenu'
import logoZarya from '@/assets/logo-zarya-64.png'
import './missionfeed.css'
import { ruleFor } from '@shared/allowRules'
import { pulseAlive, pulseSilence } from '@shared/toolPulse'
import type { ToolImage } from '@shared/images'
import type { ToolFact } from '@shared/toolFacts'

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

/** Инструменты плана: их содержание живёт в панели плана, а не в карточках. */
const PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

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
/**
 * Кнопки ленты в шапке ПАНЕЛИ: прошлые сессии Claude и запуск CLI.
 *
 * Раньше они жили в собственной шапке ленты, а та дублировала шапку панели —
 * марку и путь приходилось скрывать, и оставалась пустая полоса со своей
 * границей. Две линии подряд, между ними ничего. Лента используется ТОЛЬКО
 * внутри панели, поэтому кнопки переехали к остальным кнопкам панели, а вторая
 * шапка исчезла вместе с лишней линией и двумя десятками точек по вертикали.
 */
export function PaneFeedButtons({ sessionId }: { sessionId: string }): React.JSX.Element {
  useLang()
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

  /*
   * Унести разговор: в файл или в буфер.
   *
   * Меню, а не две кнопки: в шапке панели место наперечёт, а оба действия — про
   * одно и то же («забрать отсюда текст»). Путь выбирает ОС, потому что решать
   * за человека, где лежит его разговор, — не наше дело.
   */
  const openExportMenu = (e: React.MouseEvent): void => {
    const btn = e.currentTarget as HTMLElement
    const r = btn.getBoundingClientRect()
    const conv = convForSession(useAiStore.getState(), sessionId)
    const messages = conv?.messages ?? []
    const title = conv?.title
    const md = (): string =>
      toMarkdown(messages, {
        title,
        engine: conv?.engine,
        cwd: useSessionsStore.getState().sessions[sessionId]?.cwd,
        at: new Date().toLocaleString()
      })
    const empty = messages.length === 0
    openMenu(
      r.left,
      r.bottom + 4,
      [
        {
          label: t('feed.exportFile'),
          disabled: empty,
          onClick: () => {
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
            void window.zarya.app
              .saveTextFile(transcriptFileName(title, stamp), md())
              .then((path) => {
                // Отказ от диалога — не ошибка и не успех: молчим.
                if (path) useUiStore.getState().toast(t('feed.exportSaved', { path }), 'success')
              })
              .catch(() => useUiStore.getState().toast(t('feed.exportFailed'), 'error'))
          }
        },
        {
          label: t('feed.exportCopy'),
          disabled: empty,
          onClick: () => {
            void navigator.clipboard.writeText(md())
            useUiStore.getState().toast(t('feed.exportCopied'), 'success')
          }
        },
        { separator: true },
        {
          label: t('feed.exportScrollback'),
          onClick: () => {
            const text = getTerminal(sessionId)?.serialize(5000) ?? ''
            const plain = text.replace(/\[[0-9;?]*[a-zA-Z]/g, '')
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
            void window.zarya.app
              .saveTextFile(`терминал — ${stamp}.txt`, plain)
              .then((path) => {
                if (path) useUiStore.getState().toast(t('feed.exportSaved', { path }), 'success')
              })
              .catch(() => useUiStore.getState().toast(t('feed.exportFailed'), 'error'))
          }
        }
      ],
      btn
    )
  }

  return (
    <>
      <button className="zy-icon-btn" title={t('feed.exportHint')} onClick={openExportMenu}>
        <Icon name="download" size={13} />
      </button>
      <button className="zy-icon-btn" title={t('feed.resumeHint')} onClick={openSessionsMenu}>
        <Icon name="history" size={13} />
      </button>
      <button className="zy-icon-btn" title={t('feed.launchHint')} onClick={openCliMenu}>
        <Icon name="bolt" size={13} />
      </button>
      {cliMenu}
    </>
  )
}

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
    // `conv?.typed` — печатающийся ответ. Без него лента следовала бы только за
    // готовыми сообщениями, и длинный ответ уезжал бы под нижний край ровно в
    // тот единственный момент, ради которого печать и показывают. Правило
    // «следуем, только если человек и так внизу» здесь то же: читающего выше
    // текста никуда не тянет.
  }, [blocks, conv?.messages, conv?.typed, liveTail, waitingGateId])

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
    // Общая функция на оба места, где есть такая кнопка. Здесь подтверждения на
    // многострочный код не было вовсе: «Вставить» отправляло внутренние
    // переводы строк, оболочка принимала их за Enter — и первая строка
    // исполнялась раньше, чем человек её прочитывал (см. pasteGuard.ts).
    if (action === 'insert' || action === 'run') sendCodeToTerminal(sessionId, code, action)
  }

  const hasConv = !!conv && conv.messages.length > 0
  const isEmpty = blocks.length === 0 && !hasConv
  const cwdShort = shortenPath(cwd || '', 34)

  /*
   * СВОЕЙ ШАПКИ У ЛЕНТЫ БОЛЬШЕ НЕТ.
   *
   * Она дублировала шапку панели: та же марка «CLI-АГЕНТ · ЗАРЯ», тот же путь.
   * Внутри панели марку и путь пришлось скрыть, и осталась пустая полоса с
   * двумя кнопками — но со своей нижней границей. Получались ДВЕ линии подряд
   * с ничем между ними, и это ровно та «полоса везде», которую видно на
   * скриншотах. Кнопки переехали в шапку панели (см. PaneFeedButtons ниже) —
   * лента используется только внутри панели, дублировать её шапку незачем.
   */
  return (
    <div className="zy-mf">

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
              <AgentSection
                conv={conv}
                cwd={cwdShort}
                cwdFull={cwd}
                afterBlocks={blocks.length > 0}
              />
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
  cwdFull,
  afterBlocks
}: {
  conv: Conversation
  cwd: string
  /*
   * Полный путь папки — отдельным пропом, потому что `cwd` выше по ленте уже
   * ОБРЕЗАН для показа (shortenPath). Показывать обрезанный правильно, а вот
   * спрашивать по нему git нельзя: такой папки не существует, и панель
   * «что изменилось» молча показала бы пустой список — то есть соврала бы,
   * что ничего не менялось.
   */
  cwdFull: string
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
          index={i}
          cwd={cwd}
          cwdFull={cwdFull}
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
      {/* План выше волны: он про то, КУДА идёт агент, а волна — про то, чем
          заняты его помощники прямо сейчас. */}
      <PlanPanel plan={conv.plan} />
      <SubagentWave conv={conv} />
      {conv.compacting && (
        <div className="zy-mf-typing zy-mf-typing-compact">
          <span className="zy-mf-spinner" />
          {t('feed.compacting')}
        </div>
      )}
      {/*
        Ответ, пока он печатается. Раньше на его месте были три точки до самого
        конца: на длинном ответе по экрану нельзя было отличить «пишет» от
        «завис», и человек ждал вслепую по минуте.

        Текст здесь — ПОКАЗ, а не история: настоящим станет целое сообщение
        движка, которое придёт следом и это место займёт. Разметку не разбираем
        на лету — на полуфразе она то и дело оказывается незакрытой и дёргала бы
        экран; markdown ляжет ровно в тот миг, когда ответ дойдёт целиком.
      */}
      {conv.streaming && !conv.compacting && !!conv.typed && (
        <div className="zy-mf-answer zy-mf-answer--typing">
          {conv.typed}
          <span className="zy-mf-caret" aria-hidden />
        </div>
      )}
      {/*
        Вызов, который модель печатает прямо сейчас.

        До этого на его месте были три точки: текста при сочинении вызова нет
        вовсе, и на длинной команде человек десять секунд смотрел на «отвечает»,
        не зная, пишет агент или завис. Строка называет инструмент и показывает
        то самое поле, которое человек потом прочтёт в карточке, — карточка
        встанет ровно на это место.
      */}
      {conv.streaming && !conv.compacting && conv.typedTool && (
        <div className="zy-mf-typing zy-mf-typing-tool">
          <span className="zy-mf-spinner" />
          <span className="zy-mf-typing-tool-name">{conv.typedTool.name}</span>
          {conv.typedTool.preview && (
            <code className="zy-mf-typing-tool-arg">{conv.typedTool.preview}</code>
          )}
          <span className="zy-mf-caret" aria-hidden />
        </div>
      )}
      {conv.streaming &&
        !conv.compacting &&
        !conv.typed &&
        !conv.typedTool &&
        conv.messages[conv.messages.length - 1]?.role === 'user' && (
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
 * Остановить ОДНУ задачу, не обрывая ход.
 *
 * До этого рычаг был один — Esc, отменяющий работу целиком. Человек, видящий,
 * что субагент десять минут жжёт токены не туда, платил за это всей остальной
 * волной.
 *
 * Кнопки НЕТ, когда движок так не умеет: показать её и не смочь остановить —
 * хуже, чем не показывать. И она не рисует «остановлено» по своему успеху:
 * успех означает лишь «просьба ушла». Что задача встала, скажет сам движок
 * событием со статусом `stopped` — оно и поставит пометку в строке.
 */
function StopTaskButton({
  conv,
  taskId
}: {
  conv: Conversation
  taskId: string
}): React.JSX.Element | null {
  useLang()
  const [asked, setAsked] = useState(false)
  const caps = useUiStore((s) => s.agentCaps)
  const engine = conv.engine
  if (engine === 'builtin' || !caps?.[engine]?.stopTask) return null
  return (
    <button
      type="button"
      className="zy-mf-wave-stop"
      disabled={asked}
      title={t('feed.stopTaskHint')}
      onClick={() => {
        setAsked(true)
        void window.zarya.agent.stopTask(engine, conv.id, taskId)
      }}
    >
      {asked ? t('feed.stopTaskAsked') : t('feed.stopTask')}
    </button>
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
  // Тревожный вид — только для НАСТОЯЩЕЙ неудачи. Задача, которую остановил сам
  // человек, кончилась ровно так, как он велел: красить её знаком беды значит
  // обвинять агента в чужом решении и звать чинить то, что не сломано.
  const bad = w.broken > 0
  // Задачи — не всегда агенты: воркфлоу в счётчике «агентов» назвался бы тем,
  // чем не является. Слово выбирается по составу волны.
  const noun = w.mixed
    ? t(w.total === 1 ? 'feed.taskOne' : 'feed.taskMany')
    : t(w.total === 1 ? 'feed.agentOne' : 'feed.agentMany')
  return (
    <div
      className={`zy-mf-wave${allDone ? ' zy-mf-wave--done' : ''}${bad ? ' zy-mf-wave--bad' : ''}`}
    >
      <div className="zy-mf-wave-head">
        {/* Галочка означает «всё получилось». Ставить её, когда две задачи
            упали, — врать значком там, где цифры ещё честные. */}
        {!allDone ? (
          <span className="zy-mf-spinner" aria-hidden />
        ) : bad ? (
          <span className="zy-mf-wave-bad-mark" aria-hidden>
            ✗
          </span>
        ) : (
          <Icon name="check" size={12} />
        )}
        <span className="zy-mf-wave-count">
          {w.done}/{w.total} {noun}
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
        {w.broken > 0 && (
          <>
            <span className="zy-mf-wave-sep">·</span>
            <span className="zy-mf-wave-bad">{t('feed.waveFailed', { n: w.broken })}</span>
          </>
        )}
        {/* Остановленные — своим словом и своим цветом: их прекратил человек,
            и «не смогли» про них было бы неправдой. */}
        {w.halted > 0 && (
          <>
            <span className="zy-mf-wave-sep">·</span>
            <span className="zy-mf-wave-halted">{t('feed.waveHalted', { n: w.halted })}</span>
          </>
        )}
      </div>
      {w.running.slice(0, 4).map((r) => (
        <div key={r.taskId} className="zy-mf-wave-row">
          <span className="zy-mf-wave-dot" />
          <span className="zy-mf-wave-what">{runLabel(r)}</span>
          {/* Задачу увели в фон: ход идёт дальше, а она осталась работать.
              Без пометки она читалась бы как обычная, задержавшаяся. */}
          {r.backgrounded && <span className="zy-mf-wave-bg">{t('feed.inBackground')}</span>}
          {r.lastTool && <span className="zy-mf-wave-tool">{r.lastTool}</span>}
          <StopTaskButton conv={conv} taskId={r.taskId} />
        </div>
      ))}
      {w.running.length > 4 && (
        <div className="zy-mf-wave-row zy-mf-wave-row--more">{t('feed.andMore', { n: w.running.length - 4 })}</div>
      )}
      {/*
        Неудачи — всегда на виду и всегда своими словами. Успешную задачу можно
        свернуть в счётчик: её итог и есть счётчик. Упавшую — нельзя: ради неё
        человек в волну и смотрит, и «18 из 18» вместо неё было бы ложью.
      */}
      {w.failed.slice(0, 4).map((r) => (
        <div
          key={r.taskId}
          className={`zy-mf-wave-row zy-mf-wave-row--${r.status === 'stopped' ? 'stopped' : 'failed'}`}
        >
          <span className="zy-mf-wave-mark" aria-hidden>
            {r.status === 'stopped' ? '⏹' : '✗'}
          </span>
          <span className="zy-mf-wave-what">{runLabel(r)}</span>
          {/* Пересказ движка о том, ЧТО пошло не так. Своих слов тут нет: у нас
              нет знания о чужой неудаче, кроме этого. */}
          {r.summary && <span className="zy-mf-wave-why">{r.summary}</span>}
        </div>
      ))}
      {w.failed.length > 4 && (
        <div className="zy-mf-wave-row zy-mf-wave-row--more">
          {t('feed.andMore', { n: w.failed.length - 4 })}
        </div>
      )}
    </div>
  )
}

/**
 * План агента — чек-лист, который он ведёт себе сам.
 *
 * Единственное место в ленте, где видно НАМЕРЕНИЕ, а не следы: что впереди и на
 * каком шаге агент сейчас. Стоит там же, где строка волны субагентов, и живёт по
 * тем же правилам — узкая полоса, а не второй экран.
 *
 * Показываем пять пунктов: у человека их бывает пятнадцать, и полный список
 * закрыл бы ленту, ради которой он в панель и смотрит. Приоритет у идущего —
 * именно он отвечает на вопрос «оно движется?».
 */
function PlanPanel({ plan }: { plan?: import('@shared/agentPlan').AgentPlan }): React.JSX.Element | null {
  useLang()
  const SHOWN = 5
  if (!plan?.tasks.length) return null
  const { total, done, running } = planSummary(plan)
  const allDone = done === total
  // Идущая задача первой, дальше — по порядку плана. Так строка «чем занят
  // сейчас» не уезжает вниз, когда план длинный.
  const ordered = running ? [running, ...plan.tasks.filter((t) => t !== running)] : plan.tasks
  const shown = ordered.slice(0, SHOWN)
  return (
    <div className={`zy-mf-plan${allDone ? ' zy-mf-plan--done' : ''}`}>
      <div className="zy-mf-plan-head">
        {allDone ? <Icon name="check" size={12} /> : <span className="zy-mf-spinner" aria-hidden />}
        <span className="zy-mf-plan-title">{t('plan.title')}</span>
        <span className="zy-mf-plan-count">{t('plan.progress', { done, total })}</span>
      </div>
      {shown.map((task) => (
        <div key={task.id} className={`zy-mf-plan-row zy-mf-plan-row--${task.status}`}>
          <span className="zy-mf-plan-mark" aria-hidden>
            {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '▸' : '·'}
          </span>
          <span className="zy-mf-plan-what">
            {/* У идущей задачи движок даёт свою форму: «Запускаю тесты». */}
            {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
          </span>
        </div>
      ))}
      {ordered.length > SHOWN && (
        <div className="zy-mf-plan-row zy-mf-plan-row--more">
          {t('plan.more', { n: ordered.length - SHOWN })}
        </div>
      )}
    </div>
  )
}

const AgentMessage = memo(function AgentMessage({
  msg,
  index,
  cwd,
  cwdFull,
  covered,
  gateId,
  interrupted
}: {
  msg: Conversation['messages'][number]
  /** Место сообщения в беседе: от него считается «что тронуто с этого хода». */
  index: number
  cwd: string
  /** Настоящая папка панели — для git. `cwd` обрезан и годится только для показа. */
  cwdFull: string
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
      <UserTurn
        text={text}
        images={images}
        index={index}
        cwd={cwd}
        cwdFull={cwdFull}
        ts={msg.ts}
        interrupted={interrupted}
      />
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
        if (p.type === 'notice') {
          return <NoticeLine key={i} level={p.level} text={p.text} />
        }
        if (p.type === 'compact') {
          return <CompactMark key={i} before={p.before} after={p.after} auto={p.auto} />
        }
        if (p.type === 'thinking') {
          return <ThinkingBlock key={i} text={p.text} />
        }
        if (p.type === 'reset') {
          return <ResetMark key={i} />
        }
        if (p.type === 'turn') {
          return (
            <TurnLine
              key={i}
              durationMs={p.durationMs}
              ttftMs={p.ttftMs}
              turns={p.turns}
              denials={p.denials}
              endReason={p.endReason}
              isError={p.isError}
            />
          )
        }
        if (p.type === 'tool_use') {
          // A subagent's «Agent» card would say only «субагент работает…» while
          // the wave line above already names the task, its runtime and its
          // cost. Showing both is the same information twice, the useless copy
          // on top.
          if (covered.has(p.id)) return null
          // Задачи плана рисует панель выше, целиком и с состояниями. Карточка
          // «TaskCreate», а следом две «TaskUpdate» — это тот же список,
          // размазанный по ленте и потерявший связь между собой.
          if (PLAN_TOOLS.has(p.name)) return null
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

/**
 * Чем кончился вызов инструмента — и весь вывод, если его попросят.
 *
 * ЗАЧЕМ. Лента показывала одну первую строку и слово «готово». Для `ls` этого
 * хватает, для тестов — нет: агент говорил «готово», а какие тесты упали и
 * почему, оставалось внутри. Единственным способом узнать это было спросить
 * агента ещё раз о том, что он уже прочитал.
 *
 * Раскрытие даётся НЕ всегда: если весь вывод и есть та самая первая строка,
 * стрелка обещала бы продолжение, которого нет. Пустое раскрытие — мелкая
 * ложь, но ложь; кнопка появляется, только когда за ней правда что-то есть.
 */
/**
 * Что инструмент сделал на самом деле — строкой под итогом.
 *
 * Разбор живёт в @shared/toolFacts и присылает КЛЮЧИ словаря, а не готовые
 * фразы: иначе сохранённая беседа осталась бы на языке, который был включён в
 * день её записи. Незнакомый ключ пропускаем молча — новая версия движка не
 * должна выводить в ленту служебное имя факта.
 */
/**
 * Факты, для которых у словаря ЕСТЬ фраза.
 *
 * Словарь отдаёт сам ключ, когда фразы нет: так дыру видно глазами, но в ленте
 * это выглядело бы как «fact.bash.timeout» на месте объяснения. Отбор нужен в
 * двух местах сразу — здесь и там, где решается пометка «итог неполный»:
 * жёлтый восклицательный знак без единого слова под ним пугает, ничего не
 * сообщая.
 */
function knownFacts(facts?: ToolFact[]): ToolFact[] {
  return (facts ?? []).filter((f) => t(f.key, f.vars) !== f.key)
}

function ToolFacts({ facts }: { facts?: ToolFact[] }): React.JSX.Element | null {
  useLang()
  const known = knownFacts(facts)
  if (!known.length) return null
  return (
    <div className="zy-mf-tool-facts">
      {known.map((f, i) => (
        <span
          key={i}
          className={`zy-mf-tool-fact${f.level === 'warn' ? ' zy-mf-tool-fact--warn' : ''}`}
        >
          {t(f.key, f.vars)}
        </span>
      ))}
    </div>
  )
}

/**
 * Картинки, которые вернул инструмент.
 *
 * Показываются сразу, а не под шторкой: у вызова, чей смысл — скриншот,
 * свёрнутая картинка это та же пустая карточка, от которой избавлялись.
 *
 * Байты живут только в открытой беседе и на диск не идут (см. `toolImages`).
 * После перезапуска — и после вытеснения по бюджету — вместо картинки строка,
 * которая честно говорит, что её тут больше нет, и почему. Пустое место на её
 * месте выглядело бы как «инструмент ничего не вернул».
 */
function ToolImages({
  images,
  count,
  skipped,
  overflow
}: {
  images?: ToolImage[]
  /** Сколько картинок было по данным сообщения — переживает перезапуск. */
  count?: number
  /** Отклонены форматом или размером. */
  skipped?: number
  /** Не поместились числом — другая причина, и слова другие. */
  overflow?: number
}): React.JSX.Element | null {
  useLang()
  const gone = !images?.length && !!count
  if (!images?.length && !count && !skipped && !overflow) return null
  return (
    <div className="zy-mf-tool-imgs">
      {images?.map((img, i) => (
        <figure key={i} className="zy-mf-img">
          <img
            src={`data:${img.mediaType};base64,${img.data}`}
            alt={t('feed.toolImage', { n: i + 1 })}
            loading="lazy"
          />
          <figcaption>
            #{i + 1} · {fmtBytes(img.bytes)}
          </figcaption>
        </figure>
      ))}
      {gone && <div className="zy-mf-tool-imgs-gone">{t('feed.toolImagesGone', { n: count })}</div>}
      {!!skipped && (
        <div className="zy-mf-tool-imgs-gone">{t('feed.toolImagesSkipped', { n: skipped })}</div>
      )}
      {!!overflow && (
        <div className="zy-mf-tool-imgs-gone">{t('feed.toolImagesOverflow', { n: overflow })}</div>
      )}
    </div>
  )
}

/** «128 КБ» — размер картинки в подписи, без ложной точности. */
function fmtBytes(n: number): string {
  return n >= 1024 * 1024
    ? t('feed.mb', { n: (n / (1024 * 1024)).toFixed(1) })
    : t('feed.kb', { n: Math.max(1, Math.round(n / 1024)) })
}

function ToolOutcome({
  content,
  isError,
  incomplete
}: {
  content: string
  isError: boolean
  /**
   * Итог НЕ такой, каким выглядит: команду оборвало, файл прочитан частью,
   * поиск обрезан. Ошибкой движок это не считает — и правильно, — но зелёная
   * галочка с подписью «готово» над строкой «оборвано по времени» врёт этажом
   * выше, чем строка успевает исправить.
   */
  incomplete?: boolean
}): React.JSX.Element {
  useLang()
  const [open, setOpen] = useState(false)
  const full = content || ''
  const lines = full.split('\n')
  const first = lines[0] ?? ''
  // Есть ли что раскрывать: вторая непустая строка или хвост длинной первой.
  const more = lines.slice(1).some((l) => l.trim().length > 0) || first.length > 96
  const head = first.length > 96 ? `${first.slice(0, 96)}…` : first
  const cls = isError
    ? 'zy-mf-tool-denied'
    : incomplete
      ? 'zy-mf-tool-partial'
      : 'zy-mf-tool-done'
  const label = isError
    ? `✗ ${head || t('feed.denied')}`
    : incomplete
      ? // Не «✗»: это не ошибка. И не «готово»: готово оно не целиком.
        `! ${head || 'exit 0'}`
      : `✓ ${head || 'exit 0'} — ${t('feed.done')}`

  if (!more) return <div className={cls}>{label}</div>
  return (
    <div className="zy-mf-outcome">
      <button
        type="button"
        className={`${cls} zy-mf-outcome-head`}
        onClick={() => setOpen((v) => !v)}
        title={open ? t('feed.outcomeHide') : t('feed.outcomeShow')}
      >
        <span className="zy-mf-outcome-text">{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} />
      </button>
      {open && <pre className="zy-mf-outcome-out">{full}</pre>}
    </div>
  )
}

/**
 * Строка движка: ход оборвался, модель отказала, хук вмешался.
 *
 * Раньше такой конец не давал на экране НИЧЕГО: точки «думает» просто гасли, и
 * отличить оборванный ход от зависшего было нельзя. Текст берём у движка как
 * есть — своя формулировка тут была бы догадкой о чужой причине.
 */
function NoticeLine({
  level,
  text
}: {
  level: 'info' | 'warn' | 'error'
  text: string
}): React.JSX.Element {
  /*
   * Спокойная новость выглядит спокойно.
   *
   * Восклицательный знак и схлопнутые переносы достались всем уровням поровну, а
   * через эту же строку идёт вывод локальных команд движка (`/usage` и подобные)
   * — выровненный текст, который в один абзац превращается в кашу, да ещё и
   * помеченную тревожным знаком. Предупреждение остаётся предупреждением, а
   * сообщение — сообщением.
   */
  const calm = level === 'info'
  return (
    <div className={`zy-mf-notice zy-mf-notice-${level}${calm ? ' zy-mf-notice--calm' : ''}`}>
      <span className="zy-mf-notice-mark">{level === 'error' ? '✗' : calm ? '·' : '!'}</span>
      <span className="zy-mf-notice-text">{text}</span>
    </div>
  )
}

/**
 * Рассуждение агента — свёрнутое по умолчанию.
 *
 * В консоли его разворачивают по Ctrl+O, и это правильный порядок: рассуждение
 * нужно, когда агент выбрал не тот путь, а не в каждом ответе. Развёрнутым по
 * умолчанию оно вытеснило бы с экрана сам ответ — ради черновика мысли.
 */
function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = text.trim().split('\n').length
  return (
    <div className={`zy-mf-think${open ? ' zy-mf-think--open' : ''}`}>
      <button className="zy-mf-think-head" onClick={() => setOpen((v) => !v)}>
        <span className="zy-mf-think-caret">{open ? '▾' : '▸'}</span>
        <span className="zy-mf-think-label">{t('feed.thinking', { n: lines })}</span>
      </button>
      {open && <div className="zy-mf-think-body">{text.trim()}</div>}
    </div>
  )
}

/**
 * Итог хода: сколько шёл, через сколько заговорил, чем кончился.
 *
 * Строка приходит не после каждого ответа — только когда есть что сказать (см.
 * `aiStore`, ветка `result`). Причина стоит первой и своим цветом: «кончились
 * шаги», «упёрлись в потолок трат» и «модель вернула ошибку» — три разных
 * решения человека, а не одно слово «ошибка». Числа идут следом, приглушённо:
 * они отвечают на «долго ли», а не на «что делать».
 */
function TurnLine({
  durationMs,
  ttftMs,
  turns,
  denials,
  endReason,
  isError
}: {
  durationMs?: number
  ttftMs?: number
  turns?: number
  denials?: number
  endReason?: string
  isError?: boolean
}): React.JSX.Element {
  // Десятичный разделитель — по языку интерфейса: «2.6 с» посреди русской фразы
  // читается как чужая вставка, а число здесь стоит рядом со словами.
  const sec = (ms: number): string => {
    if (ms >= 10_000) return String(Math.round(ms / 1000))
    const one = (ms / 1000).toFixed(1)
    return currentLang() === 'ru' ? one.replace('.', ',') : one
  }
  const bits: string[] = []
  if (durationMs !== undefined) bits.push(t('feed.turnStats', { sec: sec(durationMs) }))
  // Время до первого токена показываем, только когда ход был заметно долгим:
  // на быстром ответе это цифра ради цифры.
  if (ttftMs !== undefined && (durationMs ?? 0) >= 10_000)
    bits.push(t('feed.turnTtft', { sec: sec(ttftMs) }))
  if (turns !== undefined && turns > 1) bits.push(t('feed.turnTurns', { n: turns }))
  if (denials) bits.push(t('feed.turnDenials', { n: denials }))
  return (
    <div className={`zy-mf-turn${endReason && isError ? ' zy-mf-turn--bad' : ''}`}>
      {endReason && <span className="zy-mf-turn-reason">{endReason}</span>}
      {/* Точка между причиной и числами — тем же знаком, что и внутри чисел:
          без неё фраза и цифры слипались в одну строку без границы. */}
      {endReason && bits.length > 0 && <span className="zy-mf-turn-dot">·</span>}
      {bits.length > 0 && <span className="zy-mf-turn-stats">{bits.join(' · ')}</span>}
    </div>
  )
}

/**
 * Отметка о сжатии контекста.
 *
 * Движок время от времени сворачивает историю разговора в пересказ — после
 * этого агент помнит суть, но не буквальные слова. Без отметки это выглядит
 * как внезапная потеря памяти посреди беседы. Числа — движка; если он их не
 * назвал, строка молчит о размере, а не выдумывает «примерно».
 */
function CompactMark({
  before,
  after,
  auto
}: {
  before?: number
  after?: number
  auto?: boolean
}): React.JSX.Element {
  useLang()
  const size =
    before && after ? `${fmtTokens(before)} → ${fmtTokens(after)}` : before ? fmtTokens(before) : ''
  return (
    <div className="zy-mf-compact">
      <span className="zy-mf-compact-line" />
      <span className="zy-mf-compact-body">
        <span className="zy-mf-compact-what">
          {auto ? t('feed.compactAuto') : t('feed.compactDone')}
        </span>
        {size && <span className="zy-mf-compact-size">{size}</span>}
      </span>
      <span className="zy-mf-compact-line" />
    </div>
  )
}

/**
 * Черта: выше — то, чего агент больше не помнит.
 *
 * Приходит от `/clear`, от выхода из режима плана, от новой сессии. Не то же,
 * что сжатие: там разговор остался пересказом, здесь его нет вовсе — и потому
 * черта другая, сплошная и с прямым словом.
 *
 * Ленту это не стирает. Записи выше — человека, и терять их из-за чужой
 * забывчивости нельзя; а вот молчать о границе значило бы утверждать, что
 * память на месте, когда её нет.
 */
function ResetMark(): React.JSX.Element {
  useLang()
  return (
    <div className="zy-mf-reset">
      <span className="zy-mf-reset-line" />
      <span className="zy-mf-reset-text">{t('feed.reset')}</span>
      <span className="zy-mf-reset-line" />
    </div>
  )
}

/** 128000 → «128k»: точные токены здесь ничего не решают, порядок — решает. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
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

/**
 * Ход человека: сам пузырь и кнопка «что изменилось» под ним.
 *
 * Кнопка живёт здесь, а не в общей шапке ленты, потому что вопрос человека
 * всегда звучит про КОНКРЕТНОЕ место разговора: «что он натворил, пока делал
 * вот это». Панель под своим ходом отвечает ровно на него, а панель где-то
 * сбоку заставляла бы вспоминать, к чему она относится.
 *
 * Кнопка приглушена и проявляется на наведении: на длинной ленте она стоит у
 * каждого хода, и в полную силу это был бы частокол.
 */
function UserTurn({
  text,
  images,
  index,
  cwd,
  cwdFull,
  ts,
  interrupted
}: {
  text: string
  images: Array<Extract<AiContentPart, { type: 'image' }>>
  /** Индекс этого хода в беседе. */
  index: number
  /** Обрезанный путь — только для показа в строке хода. */
  cwd: string
  /** Настоящая папка — только она годится для git. */
  cwdFull: string
  ts?: number
  interrupted?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rewind, setRewind] = useState(false)
  const feed = useContext(FeedConvContext)
  const conv = feed?.conv
  const caps = useUiStore((s) => s.agentCaps)
  // Кнопку показываем только по правилу (см. rewindGate): нет точки, нет копий
  // у этой сессии, движок так не умеет или ход выше черты /clear — кнопки нет.
  const canRewind = !!conv &&
    canRewindTurn({
      messages: conv.messages,
      index,
      engineCan: conv.engine !== 'builtin' && caps?.[conv.engine]?.rewindFiles === true
    })
  const turnId = conv?.messages[index]?.turnId
  return (
    <div className="zy-mf-userturn">
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
          <span className="zy-mf-user-cut" title={t('feed.interruptedHint')}>
            {t('feed.interrupted')}
          </span>
        )}
        {ts != null && <span className="zy-mf-user-time">{fmtClock(ts)}</span>}
        <button
          type="button"
          className={`zy-mf-changes-btn${open ? ' zy-mf-changes-btn--on' : ''}`}
          onClick={() => setOpen((v) => !v)}
          title={t('feed.changesOpen')}
        >
          <Icon name="branch" size={11} />
          <span>{t('feed.changes')}</span>
        </button>
        {canRewind && (
          <button
            type="button"
            className={`zy-mf-changes-btn${rewind ? ' zy-mf-changes-btn--on' : ''}`}
            onClick={() => setRewind((v) => !v)}
            title={t('rw.btnHint')}
          >
            <Icon name="history" size={11} />
            <span>{t('rw.btn')}</span>
          </button>
        )}
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
      {open && <ChangesPanel cwd={cwdFull} from={index} />}
      {rewind && conv && turnId && (
        <RewindCard
          conv={conv}
          turnId={turnId}
          cwd={cwdFull}
          from={index}
          onClose={() => setRewind(false)}
        />
      )}
    </div>
  )
}


const MARK_LABEL: Record<RewindMark, string> = {
  'will-delete': 'rw.mark.willDelete',
  'will-create': 'rw.mark.willCreate',
  'edited-after': 'rw.mark.editedAfter',
  'dirty-editor': 'rw.mark.dirtyEditor',
  unobserved: 'rw.mark.unobserved',
  outside: 'rw.mark.outside',
  neighbor: 'rw.mark.neighbor',
  'skip-link': 'rw.mark.skipLink',
  restore: 'rw.mark.restore'
}

/**
 * Карточка отката: что произойдёт с файлами, ДО того как это станет
 * необратимым.
 *
 * Кнопка «Откатить файлы» сама ничего не откатывает — она открывает вот это.
 * Причина в том, что родной механизм движка молчит о трёх вещах, и все три
 * воспроизведены живыми прогонами: он затирает ручные правки в файлах, которых
 * касался агент, ходит за пределы папки панели и УДАЛЯЕТ файлы, созданные
 * после выбранного хода. Список со значками — единственное место, где человек
 * об этом узнаёт вовремя.
 *
 * Две строки стоят здесь всегда, а не появляются после промаха: про то, чего
 * откат не умеет вовсе (оболочка, субагенты, пакеты), и про то, что сам он
 * необратим — у движка есть «до агента», но нет «до отката».
 *
 * ПУТЬ ОТ НАЖАТИЯ ДО ЗАПИСИ — и все выходы, каждый со своими словами:
 *
 *   [Откатить файлы]
 *         │
 *         ▼
 *   сухой прогон ──► идёт ход / висит вопрос ──► «откат после его конца»
 *         │      └─► движок не умеет ──────────► «этот движок так не умеет»
 *         │      └─► копий нет ────────────────► слова движка, дословно
 *         │      └─► путей не назвал ──────────► «объём не обещаем»
 *         ▼
 *   КАРТОЧКА: список со значками + что откат не вернёт + необратимость
 *         │
 *         │  (человек читает; мир в это время живёт своей жизнью)
 *         ▼
 *   [Откатить] ──► сверка с тем, что человек ВИДЕЛ
 *         │              │
 *         │              └─► разошлось ──► «пока вы читали, изменилось» → заново
 *         ▼
 *   копия спорных файлов ──► rewindFiles ──► пост-сверка своими глазами
 *         │                                        │
 *         ▼                                        ▼
 *   путь к копиям на экране          «вернулось N · осталось M · не знаем K»
 *                                                  │
 *                                                  ▼
 *                                    отметка в ленте — ЧИСЛАМИ, без путей
 */
function RewindCard({
  conv,
  turnId,
  cwd,
  from,
  onClose
}: {
  conv: Conversation
  turnId: string
  cwd: string
  from: number
  onClose: () => void
}): React.JSX.Element {
  useLang()
  const [refresh, setRefresh] = useState(0)
  /*
   * Соседние беседы и несохранённые вкладки читаются В МОМЕНТ запроса, а не
   * подпиской.
   *
   * Селектор, возвращающий новый массив, заставляет стор считать состояние
   * изменившимся при каждом обновлении — а во время хода они идут потоком.
   * Карточка перерисовывалась бы без остановки и не успевала показать кнопку
   * (поймано прогоном: `.zy-rw-go` не дожидался появления).
   */
  const snapshot = (): { others: Array<{ id: string; title?: string }>; dirty: string[] } => ({
    others: useAiStore
      .getState()
      .conversations.filter((c) => c.id !== conv.id)
      .map((c) => ({ id: c.id, title: c.title })),
    /*
     * Несохранённая вкладка опаснее, чем кажется: на диске сейчас версия
     * агента, файл уверенно попал бы в спокойное «вернётся», откат перепишет
     * диск — и человек либо потеряет абзац, либо затрёт откат своим Ctrl+S.
     */
    dirty: useEditorStore
      .getState()
      .files.filter((f) => f.dirty)
      .map((f) => f.path.split('\\').join('/').toLowerCase())
  })
  /*
   * Предупреждение «пока вы читали, изменилось» живёт ОТДЕЛЬНО от списка.
   *
   * Расхождение заставляет перезапросить список, а перерисовка стирала бы
   * собственное предупреждение — человек увидел бы просто новый список и не
   * понял, почему его нажатие ничего не сделало.
   */
  const [stale, setStale] = useState<string[]>([])
  const [state, setState] = useState<
    | { kind: 'checking' }
    | { kind: 'refused'; text: string }
    | {
        kind: 'plan'
        rows: ReturnType<typeof rewindPlan>['rows']
        noList: boolean
        /** Что человек ВИДИТ сейчас — с этим сверимся перед записью. */
        seen: SeenFile[]
      }
    | { kind: 'running' }
    | {
        kind: 'done'
        ok: number
        same: number
        unknown: number
        skipped: number
        stayed: string[]
        backup?: { dir?: string; saved: number; skipped: string[] }
      }
  >({ kind: 'checking' })

  useEffect(() => {
    let alive = true
    const { others, dirty } = snapshot()
    void window.zarya.agent
      .rewindFiles(conv.engine as never, conv.id, turnId, {
        dryRun: true,
        cwd,
        resume: conv.claudeSessionId,
        others
      })
      .then((r) => {
        if (!alive) return
        if (r.refused) {
          const key =
            r.refused === 'busy'
              ? 'rw.refuse.busy'
              : r.refused === 'unsupported'
                ? 'rw.refuse.unsupported'
                : r.refused === 'no-turn-id'
                  ? 'rw.refuse.noTurnId'
                  : 'rw.refuse.noSession'
          return setState({ kind: 'refused', text: t(key) })
        }
        // Причину отказа НЕ придумываем: у движка она своя, и он её называет.
        if (!r.canRewind) {
          return setState({ kind: 'refused', text: r.error || t('rw.refuse.noSession') })
        }
        const paths = r.filesChanged ?? []
        // «Откатить можно, но файлов не назову» — это не пустой список: пустой
        // читается как «ничего не изменится», то есть как знание, которого нет.
        if (!paths.length) return setState({ kind: 'plan', rows: [], noList: true, seen: [] })
        const byPath = new Map((r.facts ?? []).map((f) => [f.path, f]))
        const facts: FileFacts[] = paths.map((path) => {
          const d = byPath.get(path)
          return {
            path,
            existsNow: d?.existsNow ?? true,
            ...(d?.linkSkipped ? { linkSkipped: true } : {}),
            ...(d?.outsideCwd ? { outsideCwd: true } : {}),
            // «Наблюдали» и «правку потеряют» приходят из главного процесса:
            // там лежит отпечаток того, что записал агент, и там же читается
            // диск. Считать это в окне значило бы гадать по путям.
            observed: d?.observed === true,
            ...(d?.changedAfterAgent ? { changedAfterAgent: true } : {}),
            ...(d?.heldByPane ? { heldByPane: d.heldByPane } : {}),
            ...(dirty.includes(path.split('\\').join('/').toLowerCase())
              ? { dirtyInEditor: true }
              : {})
          }
        })
        setState({
          kind: 'plan',
          rows: rewindPlan(facts).rows,
          noList: false,
          seen: (r.facts ?? []).map((f) => ({
            path: f.path,
            existsNow: f.existsNow,
            ...(f.hash ? { hash: f.hash } : {})
          }))
        })
      })
    return () => {
      alive = false
    }
  }, [conv.id, conv.engine, conv.claudeSessionId, turnId, cwd, refresh])

  const run = async (seen: SeenFile[]): Promise<void> => {
    setStale([])
    setState({ kind: 'running' })
    const r = await window.zarya.agent.rewindFiles(conv.engine as never, conv.id, turnId, {
      dryRun: false,
      cwd,
      resume: conv.claudeSessionId,
      // То, что человек видел своими глазами. Если мир с тех пор изменился,
      // главный процесс НЕ пишет, а возвращает расхождение.
      seen
    })
    if (r.refused === 'stale') {
      // Перерисовываем список заново и требуем нового нажатия: согласие
      // относилось к другому набору файлов.
      setStale(r.stale ?? [])
      setRefresh((n) => n + 1)
      return
    }
    if (r.refused || (!r.canRewind && r.error)) {
      return setState({ kind: 'refused', text: r.error || t('rw.refuse.busy') })
    }
    // Отметка в ленте — ЧИСЛАМИ, без путей: лента уезжает на диск и в
    // стенограмму, которую человек отдаёт коллеге. Подробности живут в
    // карточке, она эфемерна.
    const ok = r.verdict?.restored ?? 0
    const same = r.verdict?.untouched ?? 0
    const note =
      t('rw.feedNote', { ok, same }) +
      (r.backup?.saved ? t('rw.feedNoteBackup', { n: r.backup.saved }) : '')
    ;(
      window as unknown as { __zaryaConvNotice?: (id: string, text: string) => void }
    ).__zaryaConvNotice?.(conv.id, note)
    // Числа — НАШЕЙ сверки, а не движка: он не считает часть своих промахов.
    setState({
      kind: 'done',
      ok: r.verdict?.restored ?? 0,
      same: r.verdict?.untouched ?? 0,
      unknown: r.verdict?.unknown ?? 0,
      skipped: r.skippedLinks ?? 0,
      stayed: r.verdict?.untouchedPaths ?? [],
      ...(r.backup ? { backup: r.backup } : {})
    })
  }

  return (
    <div className="zy-rw">
      <div className="zy-rw-head">
        <span className="zy-rw-title">{t('rw.head')}</span>
        <button type="button" className="zy-rw-x" onClick={onClose} title={t('rw.cancel')}>
          <Icon name="close" size={11} />
        </button>
      </div>

      {state.kind === 'checking' && <div className="zy-rw-note">{t('rw.checking')}</div>}
      {state.kind === 'running' && <div className="zy-rw-note">{t('rw.checking')}</div>}
      {state.kind === 'refused' && <div className="zy-rw-refuse">{state.text}</div>}

      {stale.length > 0 && (
        <div className="zy-rw-stale">
          {t('rw.stale', { n: stale.length })} {stale.map((x) => shortenPath(x, 40)).join(', ')}
        </div>
      )}
      {state.kind === 'plan' && (
        <>
          {state.noList ? (
            <div className="zy-rw-refuse">{t('rw.noFiles')}</div>
          ) : (
            <>
              <div className="zy-rw-count">{t('rw.files', { n: state.rows.length })}</div>
              <ul className="zy-rw-list">
                {state.rows.map((r) => (
                  <li key={r.path} className="zy-rw-row">
                    <span className="zy-rw-path">{shortenPath(r.path, 70)}</span>
                    {r.marks.map((m) => (
                      <span key={m} className={`zy-rw-mark zy-rw-mark--${m}`}>
                        {t(MARK_LABEL[m])}
                        {m === 'neighbor' && r.pane ? ` · ${r.pane}` : ''}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {(state.kind === 'plan' || state.kind === 'checking') && (
        <div className="zy-rw-always">
          <div>{t('rw.always')}</div>
          <div>{t('rw.noUndo')}</div>
          <div>{t('rw.convStays')}</div>
        </div>
      )}

      {state.kind === 'done' && (
        <div className="zy-rw-done">
          <div>
            {t('rw.doneCounts', { ok: state.ok, same: state.same, unknown: state.unknown })}
          </div>
          {state.skipped > 0 && <div>{t('rw.doneSkipped', { n: state.skipped })}</div>}
          {state.backup && (state.backup.saved > 0 || state.backup.skipped.length > 0) && (
            <div className="zy-rw-backup">
              {state.backup.saved > 0 && (
                <>
                  {t('rw.backup', { n: state.backup.saved })}{' '}
                  <button
                    type="button"
                    className="zy-rw-link"
                    onClick={() =>
                      state.backup?.dir && window.zarya.app.showItemInFolder(state.backup.dir)
                    }
                  >
                    {t('rw.backupOpen')}
                  </button>
                </>
              )}
              {state.backup.skipped.length > 0 && (
                <div>{t('rw.backupSkipped', { n: state.backup.skipped.length })}</div>
              )}
            </div>
          )}
          {state.stayed.length > 0 && (
            <div className="zy-rw-stayed">
              {t('rw.stayed')}{' '}
              {state.stayed.map((x) => shortenPath(x, 48)).join(', ')}
            </div>
          )}
        </div>
      )}

      {state.kind === 'plan' && !state.noList && (
        <div className="zy-rw-actions">
          <button type="button" className="zy-rw-go" onClick={() => void run(state.seen)}>
            {t('rw.go')}
          </button>
          <button type="button" className="zy-rw-cancel" onClick={onClose}>
            {t('rw.cancel')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Больше этого не рисуем: панель — обзор, а не редактор. */
const CHANGE_MAX_ROWS = 300

const CHANGE_LABEL = {
  deleted: 'feed.changeDeleted',
  renamed: 'feed.changeRenamed',
  modified: 'feed.changeModified',
  added: 'feed.changeAdded',
  untracked: 'feed.changeUntracked'
} as const

/**
 * «Что изменилось в проекте» — единственное место, которое видит ВСЕ изменения.
 *
 * Родной откат движка знает только про правки своих инструментов: работу
 * оболочки (`npm install`, `rm`, сборка), субагентов, соседней панели и самого
 * человека он не трекает вовсе. Поэтому панель построена не на том, что нам
 * рассказал агент, а на состоянии рабочего дерева — git видит всё, кем бы оно
 * ни было сделано, и работает одинаково на любом движке.
 *
 * Читаем и только читаем: `gitStatus` и `gitDiffFile` в главном процессе
 * read-only и укреплены против чужого `.git/config` (см. gitService.ts). Ни
 * одной записывающей команды здесь нет и быть не должно.
 */
function ChangesPanel({ cwd, from }: { cwd: string; from: number }): React.JSX.Element {
  useLang()
  const feed = useContext(FeedConvContext)
  const [state, setState] = useState<{
    busy: boolean
    files: ChangedFile[]
    noGit: boolean
    root: string
  }>({ busy: true, files: [], noGit: false, root: '' })
  const [nonce, setNonce] = useState(0)

  // Пути, которых агент касался начиная с этого хода. Считаются из уже
  // разобранной беседы — своего учёта в драйвере для этого заводить не нужно.
  const touched = useMemo(
    () => touchedSince(feed?.conv.messages ?? [], from),
    [feed?.conv.messages, from]
  )

  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, busy: true }))
    void window.zarya.git.status(cwd).then((st) => {
      if (!alive) return
      // null от gitStatus значит ровно одно: спросить git не удалось (нет git,
      // не репозиторий, таймаут). Пустой список файлов — это другое: репозиторий
      // есть и он чист. Разные ответы человеку, поэтому и разные ветки.
      setState({ busy: false, files: listChanges(st), noGit: !st, root: st?.root ?? '' })
    })
    return () => {
      alive = false
    }
  }, [cwd, nonce])

  // Сопоставление «путь агента → строка git» и список того, о чём git молчит.
  const marks = useMemo(
    () => matchTouched(touched, state.root || cwd, cwd, state.files.map((f) => f.path)),
    [touched, state.root, cwd, state.files]
  )

  return (
    <div className="zy-mf-changes">
      <div className="zy-mf-changes-top">
        <span className="zy-mf-changes-title">{t('feed.changesTitle')}</span>
        {!state.busy && state.files.length > 0 && (
          <span className="zy-mf-changes-count">
            {t('feed.changesSummary', { n: state.files.length })}
          </span>
        )}
        <button
          type="button"
          className="zy-mf-changes-reload"
          onClick={() => setNonce((n) => n + 1)}
          title={t('feed.changesReload')}
        >
          <Icon name="refresh" size={11} />
        </button>
      </div>
      {state.busy ? (
        <div className="zy-mf-changes-empty">{t('feed.changesBusy')}</div>
      ) : state.noGit ? (
        <div className="zy-mf-changes-empty">{t('feed.changesNoGit')}</div>
      ) : state.files.length === 0 ? (
        <div className="zy-mf-changes-empty">{t('feed.changesNone')}</div>
      ) : (
        <ul className="zy-mf-changes-list">
          {state.files.map((f) => (
            <ChangedFileRow key={f.path} file={f} cwd={cwd} byAgent={marks.inRepo.has(f.path)} />
          ))}
        </ul>
      )}
      {marks.outside.length > 0 && (
        <div className="zy-mf-changes-outside">
          <div className="zy-mf-changes-outside-top">
            {t('feed.changesOutside', { n: marks.outside.length })}
          </div>
          {marks.outside.map((p) => (
            <div key={p} className="zy-mf-changes-outside-row" title={p}>
              {shortenPath(p, 72)}
            </div>
          ))}
        </div>
      )}
      {/* Без репозитория пояснять нечего: строка про сравнение с коммитом там,
          где коммитов нет вовсе, только сбивает с толку. */}
      {!state.noGit && <div className="zy-mf-changes-hint">{t('feed.changesHint')}</div>}
    </div>
  )
}

/** Строка файла: вид, путь и дифф по требованию — содержимое тянем только при раскрытии. */
function ChangedFileRow({
  file,
  cwd,
  byAgent
}: {
  file: ChangedFile
  cwd: string
  /** Агент правил этот файл на этом ходе или позже. */
  byAgent: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<{ rows: DiffRow[]; more: number; problem?: string } | null>(null)

  useEffect(() => {
    if (!open || diff) return
    let alive = true
    void window.zarya.git.diffFile(cwd, file.path).then((d) => {
      if (!alive) return
      if (!d) return setDiff({ rows: [], more: 0, problem: t('feed.changeNoDiff') })
      // Двоичное содержимое, прочитанное как utf8, — это столбец кракозябр.
      // Честнее сказать «двоичный файл», чем показать мусор и промолчать.
      if (d.original.includes('\u0000') || d.modified.includes('\u0000')) {
        return setDiff({ rows: [], more: 0, problem: t('feed.changeBinary') })
      }
      const all = lineDiff(d.original, d.modified)
      setDiff({ rows: all.slice(0, CHANGE_MAX_ROWS), more: Math.max(0, all.length - CHANGE_MAX_ROWS) })
    })
    return () => {
      alive = false
    }
  }, [open, diff, cwd, file.path])

  return (
    <li className={`zy-mf-change zy-mf-change--${file.kind}`}>
      <button
        type="button"
        className="zy-mf-change-head"
        // У каталога нет содержимого, которое можно показать построчно.
        // Мёртвая каретка обещала бы его — поэтому у папки её просто нет.
        onClick={file.dir ? undefined : () => setOpen((v) => !v)}
        title={file.path}
      >
        <span className="zy-mf-change-kind">
          {t(file.dir && file.kind === 'untracked' ? 'feed.changeUntrackedDir' : CHANGE_LABEL[file.kind])}
        </span>
        <span className="zy-mf-change-path">{shortenPath(file.path, 64)}</span>
        {byAgent && <span className="zy-mf-change-agent">{t('feed.changeByAgent')}</span>}
        {!file.dir && (
          <span className="zy-mf-change-caret">
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={11} />
          </span>
        )}
      </button>
      {open && (
        <div className="zy-mf-diff-body">
          {!diff ? (
            <div className="zy-mf-diff-more">{t('feed.changesBusy')}</div>
          ) : diff.problem ? (
            <div className="zy-mf-diff-more">{diff.problem}</div>
          ) : (
            <>
              {diff.rows.map((l, i) => (
                <div key={i} className={`zy-mf-diff-row zy-mf-diff-row--${l.kind}`}>
                  <span className="zy-mf-diff-sign">
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="zy-mf-diff-text">{l.text || ' '}</span>
                </div>
              ))}
              {diff.more > 0 && <div className="zy-mf-diff-more">{t('feed.diffTruncated')}</div>}
            </>
          )}
        </div>
      )}
    </li>
  )
}

type DiffRow = ReturnType<typeof lineDiff>[number]

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
  const pulse = conv?.toolPulses?.[id]
  /*
   * Пока идёт — перерисовываемся раз в секунду, чтобы время шло. Считать не от
   * чего, кроме старта: вывод инструмента SDK отдаёт одним куском в конце.
   *
   * Пульс тикает по своей причине: под автопилотом гейта не было, значит нет и
   * `startedAt`, — а тишина после пульса всё равно должна становиться видимой
   * сама, не дожидаясь следующего события в беседе.
   */
  const ticking = !result0 && (!!startedAt || !!pulse)
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
    body = (
      <>
        <ToolOutcome
          content={result.content}
          isError={!!result.isError}
          // Только по фактам, которые БУДУТ показаны: пометка «!» без строки
          // под ней сообщает тревогу и не сообщает причину.
          incomplete={knownFacts(result.facts).some((f) => f.level === 'warn')}
        />
        <ToolFacts facts={result.facts} />
        <ToolImages
          images={conv.toolImages?.[id]}
          count={result.images}
          skipped={result.imagesSkipped}
          overflow={result.imagesOverflow}
        />
      </>
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
        <button
          className="zy-mf-btn-deny"
          /*
           * Кнопка делает то же, что и Esc: набранное в строке уходит агенту
           * объяснением отказа. Черновик читается в момент НАЖАТИЯ, а не при
           * отрисовке: карта черновиков не рассылает подписок, и надпись,
           * меняющаяся «иногда», врала бы чаще, чем помогала. Поэтому подпись
           * постоянна, а про жест говорит строка подсказки ниже.
           */
          onClick={() => store.denyTool(conv.id, id, paneDraft(conv.sessionId).trim() || undefined)}
        >
          {t('feed.deny')}
        </button>
        {/* Enter/Esc act on the FIRST unsettled gate, so only that card may claim
            them — otherwise a second waiting card invites a keystroke that lands
            somewhere else. */}
        {isNextGate && <span className="zy-mf-tool-kbd">Enter · Esc</span>}
        {/* Жест, которого иначе не найти: отказ с объяснением необнаружим, если
            о нём не сказать там, где решают. */}
        {isNextGate && <span className="zy-mf-tool-why">{t('feed.denyHint')}</span>}
      </div>
    )
  } else if (!conv.streaming) {
    /*
     * РЕЗУЛЬТАТА НЕ БУДЕТ.
     *
     * Гейта нет, результата нет, и ход уже кончился — прерван по Esc или
     * оборван. Раньше карточка в этом состоянии крутила спиннер и писала
     * «выполняется…»: анимация над командой, которую никто не выполняет.
     * После перезапуска было хуже всего — секундомер не восстанавливается, и
     * вечная крутилка оставалась единственным, что человек видел о вызове.
     *
     * Пометка «прервано» висит на ходе ЧЕЛОВЕКА, а не на карточке, и до этого
     * места не доходила.
     */
    body = <div className="zy-mf-tool-exec zy-mf-tool-exec--dead">{t('feed.noResult')}</div>
  } else {
    /*
     * ИДЁТ — и вопрос в том, идёт ли на самом деле.
     *
     * Секундомер отвечает только на «сколько мы ждём»: он крутится одинаково у
     * работающей команды и у повисшей. Пульс движка отвечает на «а оно живо» —
     * но лишь там, где движок его шлёт. Где не шлёт, карточка молчит об этом
     * так же, как молчала раньше: судить о смерти по тишине, которой не с чем
     * сравнить, — та же ложь, только с другой стороны (см. @shared/toolPulse).
     */
    const quiet = pulseSilence(pulse, Date.now())
    body = (
      <div className="zy-mf-tool-exec">
        <span className="zy-mf-spinner" />
        {verb.run}
        {/* Сколько уже идёт. Единственное, что мы честно знаем о команде,
            которую выполняет агент: её вывод придёт только в конце. */}
        {startedAt && (
          <span className="zy-mf-tool-elapsed">· {fmtElapsed(Date.now() - startedAt)}</span>
        )}
        {/* Точка — только пока пульс СВЕЖИЙ. Один давний удар горел бы зелёным
            часами, утверждая жизнь там, где судить о ней нечем. */}
        {pulseAlive(pulse, Date.now()) && (
          <span className="zy-mf-tool-beat" title={t('feed.pulseAlive')} aria-label={t('feed.pulseAlive')} />
        )}
        {quiet != null && (
          <span className="zy-mf-tool-quiet" title={t('feed.pulseLostHint')}>
            · {t('feed.pulseLost', { time: fmtElapsed(quiet) })}
          </span>
        )}
        {/*
          Движок повторяет упавшую подзадачу. Без этой строки повтор выглядит
          как «всё ещё идёт», и человек ждёт результата первой попытки.

          Приглушённо, а не тревожно: движок сам сообщил, что справляется. Цвет
          предупреждения тут значил бы «сделайте что-нибудь», а делать нечего —
          и такое предупреждение учит не читать предупреждения.
        */}
        {pulse?.retry && (
          <span className="zy-mf-tool-retry">
            · {t('feed.toolRetry', { n: pulse.retry.attempt, max: pulse.retry.max })}
          </span>
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
        {/*
          «хочет выполнить» — только пока РЕШЕНИЕ НЕ ПРИНЯТО. После одобрения
          команда уже идёт, и та же подпись сообщала бы о выборе, которого
          больше нет; после результата — тем более.

          Гейта нет вовсе — значит, никто ничего и не хотел: под автопилотом
          движок разрешил вызов сам, и он выполняется. Раньше здесь стояло
          «спросить не у кого — считаем, что хочет», и карточка идущей минутами
          команды всё это время утверждала, что агент только СОБИРАЕТСЯ её
          запустить, — прямо над строкой «выполняется…».
        */}
        {!view.mustShowFull && !result && !!pending && !pending.settled && (
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
