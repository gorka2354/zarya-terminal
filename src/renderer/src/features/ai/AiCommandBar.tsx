import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'
import { uid } from '@/lib/uid'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import './ai.css'
import { useAiStore } from './aiStore'

/**
 * Inline "natural language -> shell command" bar (Ctrl+I).
 * A single-shot, tool-less ai.chat request — not part of the conversation
 * store, since generated commands aren't chat history.
 */
export default function AiCommandBar(): React.JSX.Element | null {
  const aiBarOpen = useUiStore((s) => s.aiBarOpen)
  const commandBarSessionId = useAiStore((s) => s.commandBarSessionId)
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const sessionsMap = useSessionsStore((s) => s.sessions)
  const settings = useSettingsStore((s) => s.settings)

  const activeSessionId = tabs.find((t) => t.id === activeTabId)?.activeSessionId ?? null
  const sessionId = commandBarSessionId ?? activeSessionId
  const session = sessionId ? sessionsMap[sessionId] : undefined

  const [phrase, setPhrase] = useState('')
  const [preview, setPreview] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const requestIdRef = useRef<string | null>(null)

  // single persistent stream listener, filtered by our own request id
  useEffect(() => {
    const unsub = window.zarya.ai.onStream((requestId, ev) => {
      if (requestId !== requestIdRef.current) return
      if (ev.type === 'text') {
        setPreview((p) => p + ev.text)
      } else if (ev.type === 'done') {
        setStreaming(false)
      } else if (ev.type === 'error') {
        setError(ev.message)
        setStreaming(false)
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (aiBarOpen) {
      setPhrase('')
      setPreview('')
      setError(null)
      setStreaming(false)
      requestIdRef.current = null
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [aiBarOpen])

  if (!aiBarOpen) return null

  const close = (): void => {
    if (streaming && requestIdRef.current) window.zarya.ai.abort(requestIdRef.current)
    useUiStore.getState().set({ aiBarOpen: false })
  }

  const generate = (): void => {
    const text = phrase.trim()
    if (!text || streaming) return
    const requestId = uid('aicmd')
    requestIdRef.current = requestId
    setPreview('')
    setError(null)
    setStreaming(true)
    const system =
      `Ты — генератор shell-команд. ОС Windows, шелл ${session?.shellName || 'неизвестен'}, ` +
      `cwd ${session?.cwd || 'неизвестна'}. Верни ТОЛЬКО команду одной строкой, без markdown и пояснений.`
    window.zarya.ai.chat(requestId, {
      provider: settings.ai.provider,
      model: settings.ai.model,
      baseUrl: settings.ai.baseUrl || undefined,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      temperature: settings.ai.temperature,
      maxTokens: Math.min(settings.ai.maxTokens, 300)
    })
  }

  const insertOnly = (): void => {
    const cmd = preview.trim()
    if (!sessionId || !cmd) return
    window.zarya.pty.write(sessionId, cmd)
    getTerminal(sessionId)?.focus()
    close()
  }

  const insertAndRun = (): void => {
    const cmd = preview.trim()
    if (!sessionId || !cmd) return
    window.zarya.pty.write(sessionId, cmd + '\r')
    getTerminal(sessionId)?.focus()
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      setPreview('')
      setError(null)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (preview.trim() && !streaming) {
        if (e.ctrlKey) insertAndRun()
        else insertOnly()
        return
      }
      if (!e.ctrlKey) generate()
    }
  }

  const hasPreview = preview.trim().length > 0

  return (
    <div className="zy-ai-cmdbar-backdrop" onMouseDown={close}>
      <div className="zy-ai-cmdbar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-ai-cmdbar-row">
          <span className="zy-ai-cmdbar-icon">
            <Icon name="sputnik" size={15} />
          </span>
          <input
            ref={inputRef}
            className="zy-ai-cmdbar-input"
            placeholder="Опиши команду по-человечески… (Esc — закрыть)"
            value={phrase}
            disabled={streaming}
            onChange={(e) => setPhrase(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="zy-ai-cmdbar-model">
            {settings.ai.provider} · {settings.ai.model}
          </span>
        </div>
        {(hasPreview || streaming || error) && (
          <div className="zy-ai-cmdbar-preview-wrap">
            {error ? (
              <div className="zy-ai-cmdbar-error">⚠ {error}</div>
            ) : (
              <pre className="zy-ai-cmdbar-preview">
                {preview}
                {streaming && <span className="zy-ai-cursor">▍</span>}
              </pre>
            )}
          </div>
        )}
        <div className="zy-ai-cmdbar-hint">
          {!hasPreview && !streaming && (
            <span>
              <span className="zy-kbd">Enter</span> сгенерировать
            </span>
          )}
          {hasPreview && !streaming && (
            <>
              <span>
                <span className="zy-kbd">Enter</span> вставить
              </span>
              <span>
                <span className="zy-kbd">Ctrl+Enter</span> выполнить
              </span>
              <span>
                <span className="zy-kbd">Tab</span> переформулировать
              </span>
            </>
          )}
          <span>
            <span className="zy-kbd">Esc</span> закрыть
          </span>
        </div>
      </div>
    </div>
  )
}
