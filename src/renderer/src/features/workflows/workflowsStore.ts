import { create } from 'zustand'
import type { WorkflowDef } from '@shared/types'
import { registerActions } from '@/lib/actionRegistry'
import { useUiStore } from '@/state/uiStore'

/** Matches `{{paramName}}` placeholders in a workflow command template. */
const PARAM_PATTERN = '\\{\\{\\s*([^{}]+?)\\s*\\}\\}'

/**
 * Extract unique, first-seen-order parameter names referenced by a command
 * template. Pure — no DOM, safe to unit test.
 */
export function extractParamNames(template: string): string[] {
  const re = new RegExp(PARAM_PATTERN, 'g')
  const names: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(template))) {
    const name = m[1].trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/**
 * Substitute `{{param}}` placeholders in a command template with values.
 * Pure function — no DOM, no store access — so it can be unit tested in
 * isolation. Callers (the run dialog) should pre-seed `values` with each
 * WorkflowParam's `default`; any name still missing from `values` here
 * falls back to an empty string.
 */
export function substituteCommand(template: string, values: Record<string, string>): string {
  const re = new RegExp(PARAM_PATTERN, 'g')
  return template.replace(re, (_full, rawName: string) => {
    const key = rawName.trim()
    return values[key] ?? ''
  })
}

/** Seeds a values map with each param's default (or '') for dialog initial state. */
export function defaultValues(wf: WorkflowDef): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of wf.params) out[p.name] = p.default ?? ''
  return out
}

interface WorkflowsState {
  workflows: WorkflowDef[]
  loaded: boolean
  /** Id of the workflow whose run dialog is open, or null when closed. */
  runDialogId: string | null

  load: () => Promise<void>
  save: (wf: WorkflowDef) => Promise<void>
  remove: (id: string) => Promise<void>
  openRunDialog: (id: string) => void
  closeRunDialog: () => void
}

let unregisterActions: (() => void) | null = null

export const useWorkflowsStore = create<WorkflowsState>((set, get) => ({
  workflows: [],
  loaded: false,
  runDialogId: null,

  load: async () => {
    const list = await window.zarya.workflows.list()
    set({ workflows: list, loaded: true })

    // Re-register a palette action per workflow every time the list changes.
    unregisterActions?.()
    unregisterActions = registerActions(
      list.map((wf) => ({
        id: `workflow.${wf.id}`,
        title: `Workflow: ${wf.name}`,
        category: 'Workflows',
        keywords: `${wf.command} ${wf.tags.join(' ')} ${wf.description ?? ''}`,
        run: () => {
          useUiStore.getState().setSidebar('workflows')
          get().openRunDialog(wf.id)
        }
      }))
    )
  },

  save: async (wf) => {
    await window.zarya.workflows.save(wf)
    await get().load()
  },

  remove: async (id) => {
    await window.zarya.workflows.delete(id)
    await get().load()
  },

  openRunDialog: (id) => set({ runDialogId: id }),
  closeRunDialog: () => set({ runDialogId: null })
}))
