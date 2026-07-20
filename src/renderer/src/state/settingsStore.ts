import { create } from 'zustand'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings, ShellProfile } from '@shared/types'

interface SettingsState {
  settings: Settings
  loaded: boolean
  profiles: ShellProfile[]
  init: () => Promise<void>
  /** Deep-partial update persisted in main. Optimistically applied. */
  update: (patch: Partial<Settings>) => Promise<void>
  refreshProfiles: () => Promise<void>
}

function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof patch !== 'object' ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v)
  }
  return out as T
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  profiles: [],

  init: async () => {
    const [settings, profiles] = await Promise.all([
      window.zarya.settings.get(),
      window.zarya.shells.detect()
    ])
    set({ settings, profiles, loaded: true })
    window.zarya.settings.onChange((s) => set({ settings: s }))
  },

  update: async (patch) => {
    set({ settings: mergeDeep(get().settings, patch) })
    await window.zarya.settings.set(patch)
  },

  refreshProfiles: async () => {
    set({ profiles: await window.zarya.shells.detect() })
  }
}))

/** Convenience non-hook accessor. */
export function getSettings(): Settings {
  return useSettingsStore.getState().settings
}
