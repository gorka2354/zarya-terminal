import { app } from 'electron'
import { resolveLang, translate } from '../shared/i18n'
import { setLangProvider } from '../shared/lang'
import type { UiLang } from '../shared/types'
import type { SettingsStore } from './settingsStore'

/**
 * Язык текстов главного процесса.
 *
 * Главный процесс говорит с человеком реже окна, но громче: системный диалог с
 * кнопками и сообщения об ошибках обновления. Настройки у него свои же, поэтому
 * язык он берёт оттуда напрямую — гонять его через IPC было бы лишним звеном,
 * которое ещё и опаздывало бы к первому диалогу.
 */
let store: SettingsStore | null = null

export function bindLang(s: SettingsStore): void {
  store = s
  // Общий слой в главном процессе говорит на том же языке.
  setLangProvider(mainLang)
}

/**
 * Язык главного процесса.
 *
 * Локаль системы спрашиваем осторожно: юнит-тесты зовут отсюда те же функции
 * без Electron вообще, и падение на `app` скрыло бы то, ради чего их звали.
 */
function mainLang(): Exclude<UiLang, 'auto'> {
  let sys = 'en'
  try {
    sys = app?.getLocale?.() || 'en'
  } catch {
    sys = 'en'
  }
  return resolveLang(store?.get().appearance.language ?? 'auto', sys)
}

export function tm(key: string, vars?: Record<string, string | number>): string {
  return translate(mainLang(), key, vars)
}
