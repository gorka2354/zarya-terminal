import { useEffect, useRef, useState } from 'react'
import type { AiContentPart, BlockRecord } from '@shared/types'
import { onBus } from '@/lib/bus'
import { formatDuration, shortenPath } from '@/lib/ansi'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { useAiStore, type Conversation } from '@/features/ai/aiStore'
import { renderMarkdown } from '@/features/ai/markdown'
import { getTerminal } from '@/terminal/terminalRegistry'
import { Icon } from './Icon'
import { PixelIcon } from './PixelIcon'
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

export function MissionFeed({ sessionId }: { sessionId: string }): React.JSX.Element {
  const blocks = useBlocksStore((s) => s.bySession[sessionId] ?? NO_BLOCKS)
  const cwd = useSessionsStore((s) => s.sessions[sessionId]?.cwd ?? '')
  const conv = useAiStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const searchOpen = useUiStore((s) => s.searchOpenFor === sessionId)
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

  // Keep the feed pinned to the bottom as new content arrives.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks, conv?.messages, liveTail])

  // Patch-card action buttons (Скопировать / Вставить / Выполнить), wired via
  // event delegation exactly like the AI panel.
  const onFeedClick = (e: React.MouseEvent): void => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-code-action]')
    if (!btn) return
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
          title="Разделить вправо"
          onClick={() => void useSessionsStore.getState().splitActive('row')}
        >
          <Icon name="split-h" size={13} />
        </button>
        <button
          className={`zy-mf-head-btn${searchOpen ? ' zy-mf-head-btn--on' : ''}`}
          title="Найти в терминале"
          onClick={() =>
            useUiStore.getState().set({ searchOpenFor: searchOpen ? null : sessionId })
          }
        >
          <Icon name="search" size={13} />
        </button>
      </div>

      <div className="zy-mf-scroll" ref={scrollRef} onClick={onFeedClick}>
        {isEmpty ? (
          <EmptyHero />
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
            <div className="zy-mf-ready">
              <span className="zy-mf-spark"><PixelIcon name="star" /></span>
              <span className="zy-mf-cwd">{cwdShort || '~'}</span>
              <span className="zy-mf-chev"><PixelIcon name="chevron-right" /></span>
              <span className="zy-mf-ready-text">готов · введите запрос в строку ниже ↓</span>
            </div>
          </>
        )}
      </div>
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
        <AgentMessage key={i} msg={m} conv={conv} cwd={cwd} />
      ))}
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

function AgentMessage({
  msg,
  conv,
  cwd
}: {
  msg: Conversation['messages'][number]
  conv: Conversation
  cwd: string
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
          return <ToolCard key={i} conv={conv} tool={p} />
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

function ToolCard({
  conv,
  tool
}: {
  conv: Conversation
  tool: Extract<AiContentPart, { type: 'tool_use' }>
}): React.JSX.Element {
  const pending = conv.pendingTools.find((t) => t.id === tool.id)
  const result = findToolResult(conv, tool.id)
  const input = tool.input as { command?: string } | null
  const cmd = typeof input?.command === 'string' ? input.command : tool.name
  const store = useAiStore.getState()

  let body: React.JSX.Element
  if (result) {
    const first = (result.content || '').split('\n')[0]
    body = result.isError ? (
      <div className="zy-mf-tool-denied">✗ {first || 'отклонено оператором'}</div>
    ) : (
      <div className="zy-mf-tool-done">✓ {first || 'exit 0'} — готово</div>
    )
  } else if (pending && !pending.settled) {
    body = (
      <div className="zy-mf-tool-actions">
        <button className="zy-mf-btn-run" onClick={() => void store.approveTool(conv.id, tool.id)}>
          ВЫПОЛНИТЬ
        </button>
        <button className="zy-mf-btn-deny" onClick={() => store.denyTool(conv.id, tool.id)}>
          ОТКЛОНИТЬ
        </button>
      </div>
    )
  } else {
    body = (
      <div className="zy-mf-tool-exec">
        <span className="zy-mf-spinner" />
        выполняется в терминале…
      </div>
    )
  }

  return (
    <div className="zy-mf-tool">
      <div className="zy-mf-tool-head">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)">
          <path d="M8 5.5l11 6.5-11 6.5z" />
        </svg>
        <code className="zy-mf-tool-cmd">{cmd}</code>
        <span className="zy-mf-tool-note">агент хочет выполнить</span>
      </div>
      {body}
    </div>
  )
}

// -------------------------------------------------------------------- empty

function EmptyHero(): React.JSX.Element {
  return (
    <div className="zy-mf-empty">
      <div className="zy-mf-empty-mark">
        <img src={logoZarya} width={44} height={44} style={{ imageRendering: 'pixelated' }} alt="" />
      </div>
      <div className="zy-mf-empty-title">Борт готов к старту</div>
      <div className="zy-mf-empty-hint">
        введите команду с <b>$</b> или запрос агенту в строку ниже ↓
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
