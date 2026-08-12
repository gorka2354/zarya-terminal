import { t } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import type { AiContentPart, AiMessage } from '@shared/types'
import { Icon } from '@/components/Icon'
import { shortenPath } from '@/lib/ansi'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { sendCodeToTerminal } from './pasteGuard'
import './ai.css'
import { renderMarkdown } from './markdown'
import { useAiStore } from './aiStore'
import { gateLabel, orphanGates, toolLabel } from './gates'

const EXAMPLES = ['ide.ex1', 'ide.ex2', 'ide.ex3']

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

/** Short "✓ …" summary line for a settled tool result (first non-empty line, truncated). */
function summarizeToolResult(content: string | undefined): string {
  if (!content) return t('ide.done')
  const firstLine = content
    .split('\n')
    .find((l) => l.trim().length > 0)
    ?.trim()
  if (!firstLine) return t('ide.done')
  return firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine
}

export default function AiPanel(): React.JSX.Element {
  const conversations = useAiStore((s) => s.conversations)
  const activeId = useAiStore((s) => s.activeId)
  const conv = conversations.find((c) => c.id === activeId)
  const autoApprove = useSettingsStore((s) => s.settings.ai.autoApprove)
  const model = useSettingsStore((s) => s.settings.ai.model)
  const echoCwd = useSessionsStore((s) => {
    const sid = conv?.sessionId || s.activeSessionId()
    return sid ? s.sessions[sid]?.cwd : undefined
  })
  const echoCwdDisplay = echoCwd ? shortenPath(echoCwd, 26) : '~'

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
      useUiStore.getState().toast(t('ide.noBlocks'), 'info')
      return
    }
    useAiStore.getState().attachBlockContext(block, conv.id)
  }

  const addLastError = (): void => {
    if (!conv) return
    const sid = targetSessionId(conv.sessionId)
    const block = sid ? useBlocksStore.getState().lastFailedBlock(sid) : undefined
    if (!block) {
      useUiStore.getState().toast(t('ide.noErrors'), 'info')
      return
    }
    useAiStore.getState().attachBlockContext(block, conv.id)
  }

  const addGitStatus = async (): Promise<void> => {
    if (!conv) return
    const sid = targetSessionId(conv.sessionId)
    const cwd = sid ? useSessionsStore.getState().sessions[sid]?.cwd : ''
    if (!cwd) {
      useUiStore.getState().toast(t('ide.noCwd'), 'info')
      return
    }
    const status = await window.zarya.git.status(cwd)
    if (!status) {
      useUiStore.getState().toast(t('ide.notGit'), 'info')
      return
    }
    const lines = [
      t('ide.gitBranch', { branch: status.branch }),
      t('ide.gitAhead', { ahead: status.ahead, behind: status.behind }),
      t('ide.gitDirty', { n: status.dirty }),
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
      useUiStore.getState().toast(t('ide.codeCopied'), 'success')
      return
    }
    if (!sid) {
      useUiStore.getState().toast(t('ide.noSession'), 'error')
      return
    }
    // Общая функция на оба места: копии этого обработчика уже разошлись
    // однажды, и в ленте подтверждение потерялось вовсе (см. pasteGuard.ts).
    if (action === 'insert' || action === 'run') sendCodeToTerminal(sid, code, action)
  }

  const lastMsg = conv?.messages[conv.messages.length - 1]
  const showThinking = !!conv?.streaming && lastMsg?.role === 'user'

  return (
    <>
      <div className="zy-ai-caption" title={t('ide.caption')}>
        {t('ide.captionShort')}
      </div>
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
            title={t('ide.newConv')}
            onClick={() =>
              useAiStore
                .getState()
                .newConversation({
                  sessionId: useSessionsStore.getState().activeSessionId() ?? undefined
                })
            }
          >
            <Icon name="plus" size={14} />
          </button>
          {conversations.length > 1 && conv && (
            <button
              className="zy-icon-btn"
              title={t('ide.deleteConv')}
              onClick={() => {
                if (window.confirm(t('ide.deleteConvAsk')))
                  useAiStore.getState().deleteConversation(conv.id)
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
        <div className="zy-row" style={{ gap: 4 }}>
          <button
            className={`zy-btn zy-btn--sm ${conv?.agentMode ? 'zy-btn--accent' : ''}`}
            title={t('ide.agentModeLong')}
            onClick={() => conv && useAiStore.getState().setAgentMode(!conv.agentMode, conv.id)}
          >
            <Icon name="bolt" size={13} /> {t('ide.agent')}
          </button>
          <button
            className="zy-icon-btn"
            title={t('common.close')}
            onClick={() => useUiStore.getState().set({ aiPanelOpen: false })}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div className="zy-sidebar-body zy-ai-body" ref={listRef} onClick={handleBodyClick}>
        {!conv || conv.messages.length === 0 ? (
          <div className="zy-ai-empty">
            <div className="zy-empty">{t('ide.emptyHint')}</div>
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
              const toolResultsOnly =
                m.content.length > 0 && m.content.every((p) => p.type === 'tool_result')
              if (toolResultsOnly) return null
              const text = m.content
                .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
                .map((p) => p.text)
                .join('\n\n')
              if (!text) return null
              return (
                <div key={mi} className="zy-ai-round">
                  <div className="zy-ai-divider">
                    <span className="zy-ai-divider-line" />
                    <span className="zy-ai-divider-label">
                      <Icon name="bolt" size={12} />
                      {t('ide.agentAnswer')}
                    </span>
                    <span className="zy-ai-divider-line" />
                  </div>
                  <div className="zy-ai-echo">
                    <span className="zy-ai-echo-star">✦</span>
                    <span className="zy-ai-echo-cwd">{echoCwdDisplay}</span>
                    <span className="zy-ai-echo-caret">❯</span>
                    <span className="zy-ai-echo-text">{text}</span>
                  </div>
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
                      <div key={pi} className="zy-ai-answer">
                        <div
                          className="zy-md"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }}
                        />
                        {conv.streaming && isLastPart && <span className="zy-ai-cursor">▍</span>}
                      </div>
                    )
                  }
                  if (p.type === 'tool_use') {
                    const result = findToolResult(conv.messages, p.id)
                    const pendingTool = conv.pendingTools.find((t) => t.id === p.id)
                    const settled = pendingTool?.settled
                    const isAuto = pendingTool?.autoApproved
                    const input = p.input as { reason?: string } | null
                    // Same label logic as the mission feed, from the gate when there
                    // is one (it carries displayName). Reading only `command` left
                    // every non-Bash gate (Edit/Write/Read/WebFetch) showing «—» —
                    // an approval prompt describing nothing.
                    const command = pendingTool
                      ? gateLabel(pendingTool)
                      : toolLabel(p.name, p.input)
                    const reason = input?.reason
                    const denied = result?.isError && result.content === t('ai.denied')
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
        {/*
          Gates raised as a bare `permission` event, with no `tool_use` block to
          hang a card on — every engine except Claude Code (Codex, Gemini, Kimi,
          Qwen). They used to be invisible here while the keyboard shortcut still
          approved them, so the user could confirm a command they never saw.
        */}
        {conv &&
          orphanGates(conv).map((t) => (
            <div key={t.id} className="zy-ai-row zy-ai-row--assistant">
              <ToolCard
                command={gateLabel(t)}
                resolved={false}
                denied={false}
                awaitingDecision
                executing={false}
                isAuto={false}
                onApprove={() => void useAiStore.getState().approveTool(conv.id, t.id)}
                onDeny={() => useAiStore.getState().denyTool(conv.id, t.id)}
              />
            </div>
          ))}
        {showThinking && (
          <div className="zy-ai-row zy-ai-row--assistant">
            <div className="zy-ai-thinking">
              <span className="zy-ai-dot" />
              <span className="zy-ai-dot" />
              <span className="zy-ai-dot" />
            </div>
          </div>
        )}
        {conv?.error && (
          <div className="zy-ai-error">
            <span>⚠ {conv.error}</span>
            <button
              className="zy-icon-btn"
              onClick={() => useAiStore.getState().dismissError(conv.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        className="zy-ai-fuel"
        title={t('ide.fuelTitle')}
        onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
      >
        <span className="zy-ai-fuel-left">
          <Icon name="rocket" size={13} className="zy-ai-fuel-icon" />
          <span className="zy-ai-fuel-label">{t('ide.fuel')}</span>
          <span className="zy-ai-fuel-value">{t('ide.fuelNone')}</span>
        </span>
        <span className="zy-ai-fuel-right">{t('ide.console')}</span>
      </button>

      <div className="zy-ai-composer">
        {conv && conv.pendingContext.length > 0 && (
          <div className="zy-ai-chips">
            {conv.pendingContext.map((ctx) => (
              <span key={ctx.id} className="zy-ai-chip zy-ai-chip--attached">
                {ctx.label}
                <button onClick={() => useAiStore.getState().removeContext(ctx.id, conv.id)}>
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="zy-ai-chips">
          <button className="zy-ai-chip" onClick={addLastBlock}>
            {t('ide.lastBlock')}
          </button>
          <button className="zy-ai-chip" onClick={addLastError}>
            {t('ide.lastError')}
          </button>
          <button className="zy-ai-chip" onClick={() => void addGitStatus()}>
            + git status
          </button>
        </div>
        <div className="zy-ai-input-row">
          <button
            type="button"
            className={`zy-ai-star-btn ${conv?.agentMode ? 'zy-ai-star-btn--on' : ''}`}
            title={t('ide.agentMode')}
            onClick={() => conv && useAiStore.getState().setAgentMode(!conv.agentMode, conv.id)}
          >
            <Icon name="bolt" size={14} />
          </button>
          <textarea
            ref={textareaRef}
            className="zy-input zy-ai-textarea"
            placeholder={t('ide.ask')}
            title={t('ide.enterHint')}
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            rows={1}
          />
          <button
            type="button"
            className="zy-ai-model-btn"
            title={t('ide.launchpad')}
            onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
          >
            <Icon name="rocket" size={15} className="zy-ai-model-icon" />
            <span className="zy-ai-model-name">{model}</span>
            <span className="zy-ai-model-caret">▴</span>
          </button>
          {conv?.streaming ? (
            <button
              className="zy-icon-btn zy-ai-stop"
              title={t('ide.stop')}
              onClick={() => useAiStore.getState().abort(conv.id)}
            >
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              className="zy-icon-btn zy-ai-send"
              title={t('ide.send')}
              disabled={!conv}
              onClick={() => doSend(input)}
            >
              <Icon name="send" size={15} />
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
  const {
    command,
    reason,
    resolved,
    denied,
    awaitingDecision,
    executing,
    isAuto,
    resultContent,
    onApprove,
    onDeny
  } = props
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={`zy-ai-tool ${awaitingDecision ? 'zy-ai-tool--gate' : ''} ${resolved && !denied ? 'zy-ai-tool--done' : ''} ${denied ? 'zy-ai-tool--denied' : ''}`}
    >
      <div className="zy-ai-tool-head">
        <Icon name="run" size={11} className="zy-ai-tool-icon" />
        <code className="zy-ai-tool-cmd">{command || '—'}</code>
        <span className="zy-ai-tool-kicker">{t('ide.wantsToRun')}</span>
      </div>
      {reason && <div className="zy-ai-tool-reason">{reason}</div>}

      {awaitingDecision && (
        <div className="zy-ai-tool-actions">
          <button className="zy-ai-tool-btn zy-ai-tool-btn--approve" onClick={onApprove}>
            {t('ide.run')}
          </button>
          <button className="zy-ai-tool-btn zy-ai-tool-btn--deny" onClick={onDeny}>
            {t('ide.deny')}
          </button>
        </div>
      )}

      {executing && (
        <div className="zy-ai-tool-exec">
          {isAuto && <span className="zy-badge zy-badge--accent">{t('ide.auto')}</span>}
          <span className="zy-ai-tool-spinner" />
          <span className="zy-ai-tool-status">{t('ide.runningInTerm')}</span>
        </div>
      )}

      {denied && <div className="zy-ai-tool-denied">{t('ide.denied')}</div>}

      {resolved && !denied && (
        <button className="zy-ai-tool-done" onClick={() => setExpanded((v) => !v)}>
          <span className="zy-ai-tool-done-text">✓ {summarizeToolResult(resultContent)}</span>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={10} />
        </button>
      )}
      {resolved && !denied && expanded && <pre className="zy-ai-tool-out">{resultContent}</pre>}
    </div>
  )
}
