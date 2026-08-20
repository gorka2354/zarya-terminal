import { getSettings, useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'

/**
 * The IDE superstructure (Files, Monaco editor, Workflows, the IDE-agent panel)
 * is an optional layer over the base terminal — off by default. This is the
 * single toggle used by the activity bar, settings, and the command palette.
 */
export function isIdeMode(): boolean {
  return getSettings().ideMode
}

export function setIdeMode(on: boolean): void {
  void useSettingsStore.getState().update({ ideMode: on })
  if (!on) {
    // Leaving IDE mode: clear any IDE-only UI so no orphaned state points at a
    // now-hidden surface (a Files/Workflows sidebar view or the IDE-agent panel).
    const ui = useUiStore.getState()
    const patch: Record<string, unknown> = { aiPanelOpen: false }
    if (ui.sidebarView === 'files' || ui.sidebarView === 'workflows') patch.sidebarView = 'sessions'
    ui.set(patch)
  }
}

export function toggleIdeMode(): void {
  setIdeMode(!getSettings().ideMode)
}

/*
 * Прогону: включить/выключить надстройку напрямую.
 *
 * Нужен сторожу мёртвых нажатий: он проверяет КАЖДОЕ действие при выключенном
 * слое, а одно из них слой включает намеренно (быстрое открытие файла). Без
 * сброса между действиями все следующие проверялись бы уже во включённом слое,
 * то есть ни в чём.
 */
;(window as unknown as { __zaryaSetIde?: (on: boolean) => void }).__zaryaSetIde = (on) =>
  setIdeMode(on)
