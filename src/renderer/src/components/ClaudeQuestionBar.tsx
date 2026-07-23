import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeCliQuestion } from '@shared/types'
import { useAiStore, type Conversation } from '@/features/ai/aiStore'
import { Icon } from './Icon'
import './claudequestionbar.css'

const OTHER = '__other__'

/**
 * The signature "single bar morphs into a choice" surface. When the active
 * Claude Code conversation raises an AskUserQuestion, the bottom input area is
 * replaced by this native selector — options + preview panel + multi-select +
 * free-text «Другое» — mirroring Claude's own prompt but in Zarya's chrome.
 * Answering resolves the driver's canUseTool and the agent continues.
 */
export function ClaudeQuestionBar({
  conv,
  toolId,
  questions
}: {
  conv: Conversation
  toolId: string
  questions: ClaudeCliQuestion[]
}): React.JSX.Element {
  // One "active" question at a time (claude usually asks a single one); extra
  // questions are answered in sequence before the whole set submits.
  const [qi, setQi] = useState(0)
  const q = questions[Math.min(qi, questions.length - 1)]
  const options = useMemo(() => [...q.options, { label: OTHER, description: 'свой вариант' }], [q])

  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [cursor, setCursor] = useState(0)
  const otherRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Reset transient selection when a fresh question comes in.
  useEffect(() => {
    setQi(0)
    setPicked({})
    setOtherText({})
    setCursor(0)
  }, [toolId])

  useEffect(() => {
    rootRef.current?.focus()
  }, [qi, toolId])

  const answersKeyed = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {}
    questions.forEach((qq, i) => {
      const labels = (picked[i] ?? []).map((l) => (l === OTHER ? otherText[i]?.trim() || 'Другое' : l))
      if (labels.length) out[qq.question] = labels
    })
    return out
  }

  const commit = (): void => {
    useAiStore.getState().answerQuestion(conv.id, toolId, answersKeyed())
  }

  const advanceOrCommit = (): void => {
    if (qi < questions.length - 1) {
      setQi((n) => n + 1)
      setCursor(0)
    } else {
      commit()
    }
  }

  const choose = (label: string): void => {
    if (label === OTHER) {
      // toggle other selection; focus its input
      setPicked((p) => {
        const cur = new Set(p[qi] ?? [])
        if (q.multiSelect) {
          cur.has(OTHER) ? cur.delete(OTHER) : cur.add(OTHER)
        } else {
          cur.clear()
          cur.add(OTHER)
        }
        return { ...p, [qi]: [...cur] }
      })
      setTimeout(() => otherRef.current?.focus(), 20)
      return
    }
    if (q.multiSelect) {
      setPicked((p) => {
        const cur = new Set(p[qi] ?? [])
        cur.has(label) ? cur.delete(label) : cur.add(label)
        return { ...p, [qi]: [...cur] }
      })
    } else {
      // single-select: pick and (if last question) submit immediately
      setPicked((p) => ({ ...p, [qi]: [label] }))
      if (qi >= questions.length - 1) {
        useAiStore.getState().answerQuestion(conv.id, toolId, (() => {
          const out: Record<string, string[]> = {}
          questions.forEach((qq, i) => {
            const labels = i === qi ? [label] : picked[i] ?? []
            if (labels.length) out[qq.question] = labels.map((l) => (l === OTHER ? otherText[i]?.trim() || 'Другое' : l))
          })
          return out
        })())
      } else {
        setQi((n) => n + 1)
        setCursor(0)
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(options.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1
      if (idx < options.length) {
        setCursor(idx)
        choose(options[idx].label)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (q.multiSelect) advanceOrCommit()
      else choose(options[cursor].label)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      useAiStore.getState().denyTool(conv.id, toolId)
    }
  }

  const active = options[cursor]
  const preview = active && 'preview' in active ? (active as { preview?: string }).preview : undefined
  const pickedSet = new Set(picked[qi] ?? [])

  return (
    <div className="zy-cqb" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="zy-cqb-head">
        <span className="zy-cqb-badge">
          <Icon name="bolt" size={12} />
          {q.header || 'ВЫБОР'}
        </span>
        <span className="zy-cqb-question">{q.question}</span>
        {questions.length > 1 && (
          <span className="zy-cqb-count">
            {qi + 1}/{questions.length}
          </span>
        )}
        <span className="zy-cqb-spacer" />
        <button
          className="zy-cqb-skip"
          title="Отклонить (Esc)"
          onClick={() => useAiStore.getState().denyTool(conv.id, toolId)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="zy-cqb-body">
        <div className="zy-cqb-options">
          {options.map((o, i) => {
            const isOther = o.label === OTHER
            const on = pickedSet.has(o.label)
            return (
              <button
                key={o.label + i}
                className={`zy-cqb-opt${i === cursor ? ' zy-cqb-opt--cursor' : ''}${on ? ' zy-cqb-opt--on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(o.label)}
              >
                <span className="zy-cqb-opt-num">{i + 1}</span>
                {q.multiSelect && <span className={`zy-cqb-check${on ? ' zy-cqb-check--on' : ''}`} />}
                <span className="zy-cqb-opt-body">
                  <span className="zy-cqb-opt-label">{isOther ? 'Другое…' : o.label}</span>
                  {o.description && !isOther && (
                    <span className="zy-cqb-opt-desc">{o.description}</span>
                  )}
                </span>
              </button>
            )
          })}
          {pickedSet.has(OTHER) && (
            <input
              ref={otherRef}
              className="zy-cqb-other"
              placeholder="свой вариант…"
              value={otherText[qi] ?? ''}
              onChange={(e) => setOtherText((t) => ({ ...t, [qi]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  advanceOrCommit()
                }
                e.stopPropagation()
              }}
            />
          )}
        </div>

        {preview && (
          <pre className="zy-cqb-preview">{preview}</pre>
        )}
      </div>

      <div className="zy-cqb-foot">
        <span className="zy-cqb-hint">
          {q.multiSelect ? '1–9 отметить · Enter — далее' : '1–9 или ↑↓ + Enter — выбрать'} · Esc — отклонить
        </span>
        {q.multiSelect && (
          <button className="zy-cqb-confirm" onClick={advanceOrCommit}>
            {qi < questions.length - 1 ? 'Далее' : 'Подтвердить'}
          </button>
        )}
      </div>
    </div>
  )
}
