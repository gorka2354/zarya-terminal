import { useSettingsStore } from '@/state/settingsStore'
import { missingKeys, resolveLang, translate } from '@shared/i18n'
import type { UiLang } from '@shared/types'

/**
 * Язык интерфейса в окне.
 *
 * Читается из настроек и меняется мгновенно: словари лежат оба в приложении, и
 * переключение — это перерисовка, а не перезапуск и не второй установщик.
 */
export function currentLang(): Exclude<UiLang, 'auto'> {
  const setting = useSettingsStore.getState().settings.appearance.language ?? 'auto'
  return resolveLang(setting, navigator.language || 'en')
}

/**
 * Строка интерфейса ВНЕ компонента (меню, тосты, действия).
 *
 * Не хук: половина текстов рождается в обработчиках и в сторе, где хуков нет.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(currentLang(), key, vars)
}

/**
 * То же в компоненте — но с подпиской: сменил язык в настройках, и надписи
 * поменялись сразу, без перезапуска.
 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const setting = useSettingsStore((s) => s.settings.appearance.language ?? 'auto')
  const lang = resolveLang(setting, navigator.language || 'en')
  return (key, vars) => translate(lang, key, vars)
}

/** Язык как значение — когда надо ветвиться, а не переводить (форматы дат). */
export function useLang(): Exclude<UiLang, 'auto'> {
  const setting = useSettingsStore((s) => s.settings.appearance.language ?? 'auto')
  return resolveLang(setting, navigator.language || 'en')
}

// Прогонам: узнать и переключить язык, не кликая по настройкам.
;(window as unknown as { __zaryaLang?: () => string }).__zaryaLang = () => currentLang()
;(window as unknown as { __zaryaSetLang?: (l: UiLang) => void }).__zaryaSetLang = (l) => {
  void useSettingsStore.getState().update({ appearance: { language: l } as never })
}
// Полнота словарей: пропущенный ключ показывает сам себя в интерфейсе, но
// заметить это можно только зайдя в тот угол, где он живёт.
;(window as unknown as { __zaryaMissingKeys?: () => unknown }).__zaryaMissingKeys = () =>
  missingKeys()
