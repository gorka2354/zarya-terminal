import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import type { WorkflowDef, WorkflowParam } from '@shared/types'
import { fuzzyFilter } from '@/lib/fuzzy'
import { Icon } from '@/components/Icon'
import { useUiStore } from '@/state/uiStore'
import { extractParamNames, useWorkflowsStore } from './workflowsStore'
import WorkflowRunDialog from './WorkflowRunDialog'
import './workflows.css'

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'workflow'
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

const enSubStyle: React.CSSProperties = {
  fontFamily: 'var(--font-tech)',
  fontSize: 12,
  fontWeight: 400,
  color: 'var(--fg-faint)',
  letterSpacing: '.1em',
  marginLeft: 8
}

interface ParamMeta {
  description: string
  default: string
}

interface FormState {
  /** null while creating a new workflow; existing id while editing. */
  id: string | null
  name: string
  command: string
  description: string
  tagsText: string
  paramMeta: Record<string, ParamMeta>
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  command: '',
  description: '',
  tagsText: '',
  paramMeta: {}
}

/**
 * Sidebar panel for Warp-style parameterized command workflows: search,
 * grouped by tag, run/edit/delete per item, and a form to add custom ones.
 * The run dialog and the create/edit form render as overlays from here so
 * they stay reachable even when opened via the command palette action.
 */
export default function WorkflowsPanel(): React.JSX.Element {
  const workflows = useWorkflowsStore((s) => s.workflows)
  const loaded = useWorkflowsStore((s) => s.loaded)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState | null>(null)

  useEffect(() => {
    void useWorkflowsStore.getState().load()
  }, [])

  const filtered = useMemo(
    () =>
      fuzzyFilter(query, workflows, (wf) => `${wf.name} ${wf.command} ${wf.tags.join(' ')}`, 300),
    [query, workflows]
  )

  const groups = useMemo(() => {
    const map = new Map<string, WorkflowDef[]>()
    for (const wf of filtered) {
      const tags = wf.tags.length ? wf.tags : [t('wf.other')]
      for (const t of tags) {
        const list = map.get(t)
        if (list) list.push(wf)
        else map.set(t, [wf])
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))
  }, [filtered])

  const openCreate = (): void => setForm({ ...EMPTY_FORM })

  const openEdit = (wf: WorkflowDef): void => {
    const paramMeta: Record<string, ParamMeta> = {}
    for (const p of wf.params) {
      paramMeta[p.name] = { description: p.description ?? '', default: p.default ?? '' }
    }
    setForm({
      id: wf.id,
      name: wf.name,
      command: wf.command,
      description: wf.description ?? '',
      tagsText: wf.tags.join(', '),
      paramMeta
    })
  }

  const removeWorkflow = (wf: WorkflowDef): void => {
    if (window.confirm(t('wf.deleteAsk', { name: wf.name }))) {
      void useWorkflowsStore.getState().remove(wf.id)
    }
  }

  const renderItem = (wf: WorkflowDef): React.JSX.Element => (
    <div
      key={wf.id}
      className="zy-item wf-item zy-wf-card"
      onClick={() => useWorkflowsStore.getState().openRunDialog(wf.id)}
      title={wf.description || wf.command}
    >
      <span className="zy-item-icon">▸</span>
      <div className="zy-item-body">
        <div
          className="zy-item-title"
          style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--fg)' }}
        >
          {wf.name}
          {wf.builtin && (
            <span className="zy-badge" style={{ marginLeft: 6 }}>
              {t('wf.builtin')}
            </span>
          )}
        </div>
        <div
          className="zy-item-sub wf-cmd-preview"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-faint)' }}
        >
          {wf.command}
        </div>
      </div>
      <div className="zy-item-actions">
        <button
          className="zy-icon-btn"
          title={t('wf.run')}
          onClick={(e) => {
            e.stopPropagation()
            useWorkflowsStore.getState().openRunDialog(wf.id)
          }}
        >
          <Icon name="run" size={14} strokeWidth={1.6} />
        </button>
        {!wf.builtin && (
          <>
            <button
              className="zy-icon-btn"
              title={t('wf.edit')}
              onClick={(e) => {
                e.stopPropagation()
                openEdit(wf)
              }}
            >
              <Icon name="edit" size={14} strokeWidth={1.6} />
            </button>
            <button
              className="zy-icon-btn"
              title={t('wf.delete')}
              onClick={(e) => {
                e.stopPropagation()
                removeWorkflow(wf)
              }}
            >
              <Icon name="trash" size={14} strokeWidth={1.6} />
            </button>
          </>
        )}
      </div>
    </div>
  )

  return (
    <>
      <style>{`
        .zy-wf-card {
          border: 1px solid var(--border);
          border-radius: 3px;
          transition: border-color .12s ease;
        }
        .zy-wf-card:hover {
          border-color: var(--accent);
        }
      `}</style>
      <div className="zy-sidebar-header">
        <span>
          Workflows
          <span style={enSubStyle}>FLOWS</span>
        </span>
        <button className="zy-icon-btn" title={t('wf.new')} onClick={openCreate}>
          <Icon name="plus" size={15} strokeWidth={1.6} />
        </button>
      </div>
      <div className="zy-sidebar-search">
        <input
          className="zy-input"
          placeholder={t('wf.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="zy-sidebar-body">
        {!loaded && <div className="zy-empty">{t('wf.loading')}</div>}
        {loaded && !groups.length && (
          <div className="zy-empty">
            {t('wf.nothing')}
            <br />
            {t('wf.createHint')}
          </div>
        )}
        {groups.map(([tag, items]) => (
          <div key={tag}>
            <div className="zy-section-label">{tag}</div>
            {items.map(renderItem)}
          </div>
        ))}
      </div>
      <WorkflowRunDialog />
      {form && <WorkflowFormModal form={form} onClose={() => setForm(null)} />}
    </>
  )
}

function WorkflowFormModal({
  form,
  onClose
}: {
  form: FormState
  onClose: () => void
}): React.JSX.Element {
  const [local, setLocal] = useState<FormState>(form)
  const paramNames = useMemo(() => extractParamNames(local.command), [local.command])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setParamField = (name: string, field: keyof ParamMeta, value: string): void => {
    setLocal((s) => {
      const cur = s.paramMeta[name] ?? { description: '', default: '' }
      return { ...s, paramMeta: { ...s.paramMeta, [name]: { ...cur, [field]: value } } }
    })
  }

  const submit = (): void => {
    const name = local.name.trim()
    const command = local.command.trim()
    if (!name || !command) {
      useUiStore.getState().toast(t('wf.needNameCmd'), 'error')
      return
    }
    const existingIds = new Set(useWorkflowsStore.getState().workflows.map((w) => w.id))
    if (local.id) existingIds.delete(local.id)
    const id = local.id ?? uniqueId(slugify(name), existingIds)

    const params: WorkflowParam[] = paramNames.map((pname) => {
      const meta = local.paramMeta[pname]
      const description = meta?.description.trim()
      const def = meta?.default.trim()
      return {
        name: pname,
        ...(description ? { description } : {}),
        ...(def ? { default: def } : {})
      }
    })

    const wf: WorkflowDef = {
      id,
      name,
      ...(local.description.trim() ? { description: local.description.trim() } : {}),
      command,
      params,
      tags: local.tagsText
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      builtin: false
    }
    void useWorkflowsStore.getState().save(wf)
    onClose()
  }

  return (
    <div
      className="zy-overlay-backdrop zy-overlay-backdrop--center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="zy-modal wf-form-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-sidebar-header">
          <span>{t(local.id ? 'wf.editTitle' : 'wf.new')}</span>
          <button className="zy-icon-btn" title={t('wf.close')} onClick={onClose}>
            <Icon name="close" size={14} strokeWidth={1.6} />
          </button>
        </div>
        <div className="wf-form-body">
          <label className="wf-field">
            <span className="wf-label">{t('wf.name')}</span>
            <input
              className="zy-input"
              value={local.name}
              onChange={(e) => setLocal((s) => ({ ...s, name: e.target.value }))}
              placeholder={t('wf.namePh')}
            />
          </label>
          <label className="wf-field">
            <span className="wf-label">{t('wf.command', { param: '{{param}}' })}</span>
            <textarea
              className="zy-input zy-input--mono wf-command-input"
              rows={3}
              value={local.command}
              onChange={(e) => setLocal((s) => ({ ...s, command: e.target.value }))}
              placeholder="git reset --soft HEAD~{{count}}"
            />
          </label>
          {paramNames.length > 0 && (
            <div className="wf-params-editor">
              <div className="wf-label">{t('wf.params')}</div>
              {paramNames.map((pname) => (
                <div key={pname} className="wf-param-row">
                  <span className="zy-kbd wf-param-kbd">{`{{${pname}}}`}</span>
                  <input
                    className="zy-input wf-input-sm"
                    placeholder={t('wf.paramDesc')}
                    value={local.paramMeta[pname]?.description ?? ''}
                    onChange={(e) => setParamField(pname, 'description', e.target.value)}
                  />
                  <input
                    className="zy-input wf-input-sm"
                    placeholder={t('wf.paramDefault')}
                    value={local.paramMeta[pname]?.default ?? ''}
                    onChange={(e) => setParamField(pname, 'default', e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
          <label className="wf-field">
            <span className="wf-label">{t('wf.desc')}</span>
            <input
              className="zy-input"
              value={local.description}
              onChange={(e) => setLocal((s) => ({ ...s, description: e.target.value }))}
              placeholder={t('wf.descPh')}
            />
          </label>
          <label className="wf-field">
            <span className="wf-label">{t('wf.tags')}</span>
            <input
              className="zy-input"
              value={local.tagsText}
              onChange={(e) => setLocal((s) => ({ ...s, tagsText: e.target.value }))}
              placeholder={t('wf.tagsPh')}
            />
          </label>
        </div>
        <div className="wf-form-actions">
          <button className="zy-btn zy-btn--ghost" onClick={onClose}>
            {t('wf.cancel')}
          </button>
          <button className="zy-btn zy-btn--accent" onClick={submit}>
            {t('wf.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
