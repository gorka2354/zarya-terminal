import { useSettingsStore } from '@/state/settingsStore'
import type { UiLang } from '@shared/types'

/**
 * Зафиксировать язык интерфейса в тесте.
 *
 * Без этого проверки текста зависят от локали машины: язык по умолчанию —
 * «как в системе», поэтому одна и та же строка выходит русской на русской
 * Windows и английской на англоязычном раннере. Тест, который зелен только у
 * автора, хуже отсутствующего: он врёт ровно там, где должен ловить.
 */
export function setUiLang(lang: UiLang): void {
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, appearance: { ...s.settings.appearance, language: lang } }
  }))
}
