import { translate } from './i18n'
import type { UiLang } from './types'

/**
 * Переводчик для общего слоя (shared).
 *
 * Здесь живут проверки картинок и подписи защиты ключей — код, который читают
 * и окно, и главный процесс. Язык у каждого свой источник: окно берёт его из
 * стора настроек, главный процесс — из файла настроек. Поэтому shared не тянет
 * ни то, ни другое, а спрашивает у того, кто его завёл.
 *
 * Пока никто не завёл — английский: это язык по умолчанию, и молчаливый
 * русский в английской сборке был бы хуже, чем честный дефолт.
 */
let provider: () => Exclude<UiLang, 'auto'> = () => 'en'

export function setLangProvider(fn: () => Exclude<UiLang, 'auto'>): void {
  provider = fn
}

export function ts(key: string, vars?: Record<string, string | number>): string {
  return translate(provider(), key, vars)
}
