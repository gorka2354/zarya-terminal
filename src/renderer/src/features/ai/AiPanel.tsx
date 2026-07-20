import { useEffect, useRef, useState } from 'react'
import type { AiContentPart, AiMessage } from '@shared/types'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import './ai.css'
import { renderMarkdown } from './markdown'
import { useAiStore } from './aiStore'

const EXAMPLES = ['Объясни последнюю ошибку', 'Найди большие файлы', 'Что съедает порт 3000?']

/** Find the tool_result matching a tool_use id, searched across all messages. */
function findToolResult(
  messages: AiMessage[],
  toolUseId: string
): Extract<AiContentPart, { type: 'tool_result' }> | undefined {
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === 'tool_result' && p.toolUseId === toolUseId) return p
    }
  }
  return undefined
}

function targetSessionId(sessionId: string | undefined): string | null {
  return sessionId || useSessionsStore.getState().activeSessionId()
}

export default function AiPanel(): React.JSX.Element {
  const conversations = useAiStore((s) => s.conversations)
  const activeId = useAiStore((s) => s.activeId)
  const conv = conversations.find((c) => c.id === activeId)
  const autoApprove = useSettingsStore((s) => s.settings.ai.autoApprove)

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!conversations.length) useAiStore.getState().newConversation()
  }, [conversations.length])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conv?.messages, conv?.streaming, conv?.pendingTools])

  const busy = !!conv && (conv.streaming || conv.pendingTools.length > 0)

  const doSend = (text: string): void => {
    if (!conv || busy) return
    const trimmed = text.trim()
    if (!trimmed && !conv.pendingContext.length) return
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    void useAiStore.getState().send(trimmed, { conversationId: conv.id })
  }

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend(input)
    }
  }

  const addLastBlock = (): void => {
    if (!conv) return
    const sid = targetSessionId(conv.sessionId)
    const block = sid ? useBlocksStore.getState().lastBlock(sid) : undefined
    if (!block) {
      useUiStore.getState().toast('Нет блоков в этой сессии', 'info')
      return
    }
    useAiStore.getState().attachBlockContext(block, conv.id)
  }

  const addLastError = (): void => {
    if (!conv) return
    const sid = targetSessionId(conv.sessionId)
    const block = sid ? useBlocksStore.getState().lastFailedBlock(sid) : undefined
    if (!block) {
      useUiStore.getState().toast('Ошибок в этой сессии не найдено', 'info')
      return
    }
    useAiStore.getState().attachBlockContext(block, conv.id)
  }

  const addGitStatus = async (): Promise<void> => {
    if (!conv) return
    const sid = targetSessionId(conv.sessionId)
    const cwd = sid ? useSessionsStore.getState().sessions[sid]?.cwd : ''
    if (!cwd) {
      useUiStore.getState().toast('Неизвестна рабочая директория', 'info')
      return
    }
    const status = await window.zarya.git.status(cwd)
    if (!status) {
      useUiStore.getState().toast('Это не git-репозиторий', 'info')
      return
    }
    const lines = [
      `Ветка: ${status.branch}`,
      `Опережение/отставание от upstream: +${status.ahead}/-${status.behind}`,
      `Изменено файлов: ${status.dirty}`,
      ...status.files.slice(0, 30).map((f) => `${f.status} ${f.path}`)
    ]
    useAiStore.getState().attachContext('git status', lines.join('\n'), conv.id)
  }

  const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement
    const btn = target.closest<HTMLElement>('[data-code-action]')
    if (!btn) {
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
    const sid = targetSessionId(conv?.sessionId)

    if (action === 'copy') {
      void navigator.clipboard.writeText(code)
      useUiStore.getState().toast('Код скопирован', 'success')
      return
    }
    if (!sid) {
      useUiStore.getState().toast('Нет активной терминальной сессии', 'error')
      return
    }
    if (action === 'insert') {
      // "Insert" must not silently execute. A trailing newline (and any
      // embedded ones in multi-line snippets) would submit the command to the
      // shell — strip the trailing one, and for multi-line snippets require the
      // same explicit confirmation as "run".
      const noTrailing = code.replace(/\r?\n$/, '')
      const lineCount = noTrailing.split('\n').length
      if (lineCount > 1 && !window.confirm(`Вставить ${lineCount} строк(и)? Многострочная вставка может выполниться сразу.`)) return
      window.zarya.pty.write(sid, noTrailing)
      getTerminal(sid)?.focus()
    } else if (action === 'run') {
      const lineCount = code.trim().split('\n').length
      if (lineCount > 1 && !window.confirm(`Выполнить ${lineCount} строк(и) команд в терминале?`)) return
      window.zarya.pty.write(sid, code + '\r')
      getTerminal(sid)?.focus()
    }
  }

  const lastMsg = conv?.messages[conv.messages.length - 1]
  const showThinking = !!conv?.streaming && lastMsg?.role === 'user'

  return (
    <>
      <div className="zy-sidebar-header">
        <div className="zy-row" style={{ gap: 6, minWidth: 0 }}>
          <select
            className="zy-select zy-ai-select"
            value={activeId ?? ''}
            onChange={(e) => useAiStore.getState().setActiveConversation(e.target.value)}
          >
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <button
            className="zy-icon-btn"
            title="Новая беседа"
            onClick={() =>
              useAiStore.getState().newConversation({ sessionId: useSessionsStore.getState().activeSessionId() ?? undefined })
            }
          >
            +
          </button>
          {conversations.length > 1 && conv && (
            <button
              className="zy-icon-btn"
              title="Удалить беседу"
              onClick={() => {
                if (window.confirm('Удалить эту беседу?')) useAiStore.getState().deleteConversation(conv.id)
              }}
            >
              🗑
            </button>
          )}
        </div>
        <div className="zy-row" style={{ gap: 4 }}>
          <button
            className={`zy-btn zy-btn--sm ${conv?.agentMode ? 'zy-btn--accent' : ''}`}
            title="Агентный режим: AI сможет сам выполнять команды в терминале (с подтверждением, если авто-подтверждение выключено в настройках AI)"
            onClick={() => conv && useAiStore.getState().setAgentMode(!conv.agentMode, conv.id)}
          >
            ⚡ Агент
          </button>
          <button className="zy-icon-btn" title="Закрыть" onClick={() => useUiStore.getState().set({ aiPanelOpen: false })}>
            ✕
          </button>
        </div>
      </div>

      <div className="zy-sidebar-body zy-ai-body" ref={listRef} onClick={handleBodyClick}>
        {!conv || conv.messages.length === 0 ? (
          <div className="zy-ai-empty">
            <div className="zy-empty">
              Спросите что-нибудь про терминал, файлы или git — или включите агентный режим, чтобы AI сам выполнял
              команды.
            </div>
            <div className="zy-ai-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="zy-ai-example" onClick={() => doSend(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          conv.messages.map((m, mi) => {
            const isLastMsg = mi === conv.messages.length - 1
            if (m.role === 'user') {
              const toolResultsOnly = m.content.length > 0 && m.content.every((p) => p.type === 'tool_result')
              if (toolResultsOnly) return null
              const text = m.content
                .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
                .map((p) => p.text)
                .join('\n\n')
              if (!text) return null
              return (
                <div key={mi} className="zy-ai-row zy-ai-row--user">
                  <div className="zy-ai-bubble zy-ai-bubble--user">{text}</div>
                </div>
              )
            }
            return (
              <div key={mi} className="zy-ai-row zy-ai-row--assistant">
                {m.content.map((p, pi) => {
                  const isLastPart = isLastMsg && pi === m.content.length - 1
                  if (p.type === 'text') {
                    if (!p.text && !(conv.streaming && isLastPart)) return null
                    return (
                      <div key={pi} className="zy-ai-bubble zy-ai-bubble--assistant">
                        <div className="zy-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} />
                        {conv.streaming && isLastPart && <span className="zy-ai-cursor">▍</span>}
                      </div>
                    )
                  }
                  if (p.type === 'tool_use') {
                    const result = findToolResult(conv.messages, p.id)
                    const pendingTool = conv.pendingTools.find((t) => t.id === p.id)
                    const settled = pendingTool?.settled
                    const isAuto = pendingTool?.autoApproved
                    const input = p.input as { command?: string; reason?: string } | null
                    const command = input?.command ?? ''
                    const reason = input?.reason
                    const denied = result?.isError && result.content === 'Пользователь отклонил выполнение'
                    return (
                      <ToolCard
                        key={pi}
                        command={command}
                        reason={reason}
                        resolved={!!result}
                        denied={!!denied}
                        awaitingDecision={!!pendingTool && !settled}
                        executing={!!pendingTool && !!settled}
                        isAuto={!!isAuto}
                        resultContent={result?.content}
                        onApprove={() => void useAiStore.getState().approveTool(conv.id, p.id)}
                        onDeny={() => useAiStore.getState().denyTool(conv.id, p.id)}
                      />
                    )
                  }
                  return null
                })}
              </div>
            )
          })
        )}
        {showThinking && (
          <div className="zy-ai-row zy-ai-row--assistant">
            <div className="zy-ai-bubble zy-ai-bubble--assistant zy-ai-thinking">
              <span className="zy-ai-dot" />
              <span className="zy-ai-dot" />
              <span className="zy-ai-dot" />
            </div>
          </div>
        )}
        {conv?.error && (
          <div className="zy-ai-error">
            <span>⚠ {conv.error}</span>
            <button className="zy-icon-btn" onClick={() => useAiStore.getState().dismissError(conv.id)}>
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="zy-ai-composer">
        {conv && conv.pendingContext.length > 0 && (
          <div className="zy-ai-chips">
            {conv.pendingContext.map((ctx) => (
              <span key={ctx.id} className="zy-ai-chip zy-ai-chip--attached">
                {ctx.label}
                <button onClick={() => useAiStore.getState().removeContext(ctx.id, conv.id)}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="zy-ai-chips">
          <button className="zy-ai-chip" onClick={addLastBlock}>
            + Последний блок
          </button>
          <button className="zy-ai-chip" onClick={addLastError}>
            + Последняя ошибка
          </button>
          <button className="zy-ai-chip" onClick={() => void addGitStatus()}>
            + git status
          </button>
        </div>
        <div className="zy-ai-input-row">
          <textarea
            ref={textareaRef}
            className="zy-input zy-ai-textarea"
            placeholder="Спросите AI… (Enter — отправить, Shift+Enter — новая строка)"
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            rows={1}
          />
          {conv?.streaming ? (
            <button
              className="zy-icon-btn zy-ai-stop"
              title="Остановить"
              onClick={() => useAiStore.getState().abort(conv.id)}
            >
              ■
            </button>
          ) : (
            <button
              className="zy-icon-btn zy-ai-send"
              title="Отправить"
              disabled={!conv}
              onClick={() => doSend(input)}
            >
              ➤
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function ToolCard(props: {
  command: string
  reason?: string
  resolved: boolean
  denied: boolean
  awaitingDecision: boolean
  executing: boolean
  isAuto: boolean
  resultContent?: string
  onApprove: () => void
  onDeny: () => void
}): React.JSX.Element {
  const { command, reason, resolved, denied, awaitingDecision, executing, isAuto, resultContent, onApprove, onDeny } =
    props
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`zy-ai-tool ${resolved && !denied ? 'zy-ai-tool--done' : ''} ${denied ? 'zy-ai-tool--denied' : ''}`}>
      <div className="zy-ai-tool-head">
        <span className="zy-ai-tool-icon">▶</span>
        <code className="zy-ai-tool-cmd">{command || '—'}</code>
      </div>
      {reason && <div className="zy-ai-tool-reason">{reason}</div>}

      {awaitingDecision && (
        <div className="zy-ai-tool-actions">
          <button className="zy-btn zy-btn--sm zy-btn--accent" onClick={onApprove}>
            Выполнить
          </button>
          <button className="zy-btn zy-btn--sm zy-btn--ghost" onClick={onDeny}>
            Отклонить
          </button>
        </div>
      )}

      {executing && (
        <div className="zy-ai-tool-actions">
          {isAuto && <span className="zy-badge zy-badge--accent">авто</span>}
          <span className="zy-ai-tool-status">Выполняется…</span>
        </div>
      )}

      {resolved && (
        <button className="zy-ai-tool-toggle" onClick={() => setExpanded((v) => !v)}>
          {denied ? '✕ Отклонено' : `${expanded ? '▾' : '▸'} Результат`}
        </button>
      )}
      {resolved && !denied && expanded && <pre className="zy-ai-tool-out">{resultContent}</pre>}
    </div>
  )
}
