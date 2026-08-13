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
    // Показываем сразу — интерфейс не должен ждать диска ради галочки.
    set({ settings: mergeDeep(get().settings, patch) })
    /*
     * ОТВЕТ ГЛАВНОГО ПРОЦЕССА ПЕРЕВЕШИВАЕТ наше предположение.
     *
     * Он не просто пишет патч: профили проходят через стража (человек может
     * ОТКЛОНИТЬ добавление) и через чистку — часть значений оттуда возвращается
     * иной. Оставить на экране оптимистичный вариант значило бы показывать
     * настройку, которой на диске нет: человек нажал «отклонить», а список
     * профилей выглядит так, будто он согласился.
     */
    const applied = await window.zarya.settings.set(patch)
    if (applied) set({ settings: applied })
  },

  refreshProfiles: async () => {
    set({ profiles: await window.zarya.shells.detect() })
  }
}))

/*
 * QA-хук: какие профили видит выбор панели.
 *
 * Проверять по экрану нельзя — список живёт в выпадающем поле, и его содержимое
 * зависит от того, открыто оно или нет. Вопрос же простой: доехал ли только что
 * добавленный профиль до места, где человек его выберет.
 */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __zaryaDumpProfiles?: () => unknown }).__zaryaDumpProfiles = () =>
    useSettingsStore.getState().profiles.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      args: p.args,
      integration: p.integration,
      detected: p.detected === true
    }))
}

/** Convenience non-hook accessor. */
export function getSettings(): Settings {
  return useSettingsStore.getState().settings
}

// QA hooks (same pattern as __zaryaSetUi / __zaryaNewTerminal): let a harness
// read and drive settings without clicking through the UI.
//
// Под проверкой окна нет: юнит-тесты берут отсюда язык и настройки, а падение
// на первой же строке импорта скрыло бы всё, ради чего файл подключали.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __zaryaSettings?: () => Settings }).__zaryaSettings = () =>
    useSettingsStore.getState().settings
  ;(window as unknown as { __zaryaSetFontSize?: (v: number) => void }).__zaryaSetFontSize = (v) =>
    void useSettingsStore.getState().update({ appearance: { fontSize: v } as never })
  // Проект в закладки — прогону, который проверяет проекты в шапке: настоящий
  // выбор папки открывает системное окно, и нажать его прогон не может.
  ;(window as unknown as { __zaryaAddProject?: (dir: string) => void }).__zaryaAddProject = (
    dir
  ) => {
    const cur = useSettingsStore.getState().settings.bookmarks
    if (!cur.includes(dir)) void useSettingsStore.getState().update({ bookmarks: [...cur, dir] })
  }
}
