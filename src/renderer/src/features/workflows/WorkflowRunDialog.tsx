import { useEffect, useState } from 'react'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { defaultValues, substituteCommand, useWorkflowsStore } from './workflowsStore'

/**
 * Run dialog for a workflow: one input per param (pre-filled with its
 * default), a live preview of the substituted command, and two ways to
 * dispatch it into the active terminal session — insert only, or run.
 * Renders null when no workflow is selected, so it's safe to mount always.
 */
export default function WorkflowRunDialog(): React.JSX.Element | null {
  const runDialogId = useWorkflowsStore((s) => s.runDialogId)
  const workflows = useWorkflowsStore((s) => s.workflows)
  const wf = workflows.find((w) => w.id === runDialogId) ?? null

  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    if (wf) setValues(defaultValues(wf))
  }, [wf])

  useEffect(() => {
    if (!runDialogId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useWorkflowsStore.getState().closeRunDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runDialogId])

  if (!wf) return null

  const preview = substituteCommand(wf.command, values)
  const close = (): void => useWorkflowsStore.getState().closeRunDialog()

  const dispatch = (withEnter: boolean): void => {
    const sessionId = useSessionsStore.getState().activeSessionId()
    if (!sessionId) {
      useUiStore.getState().toast('Нет активной сессии терминала', 'error')
      return
    }
    window.zarya.pty.write(sessionId, withEnter ? preview + '\r' : preview)
    getTerminal(sessionId)?.focus()
    close()
  }

  return (
    <div
      className="zy-overlay-backdrop zy-overlay-backdrop--center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="zy-modal wf-run-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-sidebar-header">
          <span>{wf.name}</span>
          <button className="zy-icon-btn" title="Закрыть" onClick={close}>
            ✕
          </button>
        </div>
        <div className="wf-run-body">
          {wf.description && <p className="wf-run-desc">{wf.description}</p>}
          {wf.params.map((p, i) => (
            <label key={p.name} className="wf-field">
              <span className="wf-label">
                {p.name}
                {p.description ? ` — ${p.description}` : ''}
              </span>
              <input
                className="zy-input zy-input--mono"
                value={values[p.name] ?? ''}
                placeholder={p.default ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus={i === 0}
              />
            </label>
          ))}
          <div className="wf-field">
            <span className="wf-label">Итоговая команда</span>
            <pre className="wf-preview">{preview || ' '}</pre>
          </div>
        </div>
        <div className="wf-form-actions">
          <button className="zy-btn zy-btn--ghost" onClick={close}>
            Отмена
          </button>
          <button className="zy-btn" onClick={() => dispatch(false)}>
            Вставить
          </button>
          <button className="zy-btn zy-btn--accent" onClick={() => dispatch(true)}>
            Запустить
          </button>
        </div>
      </div>
    </div>
  )
}
