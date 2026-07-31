/**
 * Насколько на самом деле защищён сохранённый ключ.
 *
 * Раньше интерфейс рисовал один зелёный бейдж «Ключ сохранён» на все случаи —
 * и когда ключ лежит в хранилище ОС, и когда он лежит base64, то есть открытым
 * текстом. Это то же враньё, что и гейт, обещающий спросить и не спрашивающий:
 * человек видит зелёное и считает вопрос закрытым.
 *
 * Различать надо два независимых обстоятельства:
 *  1. КАК ключ записан — по префиксу в файле (`enc:` или `b64:`);
 *  2. ЧТО умеет система СЕЙЧАС — `safeStorage` и его backend.
 *
 * Второе важно отдельно: на Linux без keyring Electron отдаёт backend
 * `basic_text`, и `encryptString` там даёт префикс `enc:`, не защищая ничего.
 * Судить по одному префиксу — значит показывать зелёное поверх открытого текста.
 */

import { ts } from './lang'

export type SecretProtection =
  /** Ключа нет. */
  | 'none'
  /** Хранилище ОС: DPAPI, Keychain, kwallet/gnome-libsecret. */
  | 'os'
  /** Зашифровано, но backend сам по себе не защищает (Linux basic_text). */
  | 'weak'
  /** Лежит открытым текстом (base64) — safeStorage не был доступен при записи. */
  | 'plain'

/** Backend'ы Electron, которые не дают настоящей защиты. */
const WEAK_BACKENDS = new Set(['basic_text', 'unknown'])

/**
 * @param stored     значение из secrets.json (с префиксом) или undefined
 * @param available  `safeStorage.isEncryptionAvailable()` сейчас
 * @param backend    `safeStorage.getSelectedStorageBackend()` — только Linux,
 *                   на других платформах пусто
 */
export function classifyProtection(
  stored: string | undefined,
  available: boolean,
  backend?: string
): SecretProtection {
  if (!stored) return 'none'
  // Открытый текст остаётся открытым текстом независимо от того, что система
  // умеет сегодня: ключ уже лежит на диске в читаемом виде.
  if (stored.startsWith('b64:')) return 'plain'
  if (!stored.startsWith('enc:')) return 'plain'
  if (!available) return 'weak'
  if (backend && WEAK_BACKENDS.has(backend)) return 'weak'
  return 'os'
}

/** Короткая надпись на бейдже. */
export function protectionLabel(p: SecretProtection): string {
  switch (p) {
    case 'os':
      return ts('sec.os')
    case 'weak':
      return ts('sec.weak')
    case 'plain':
      return ts('sec.plain')
    default:
      return ts('sec.none')
  }
}

/**
 * Объяснение — почему так и что с этим делать. Бейдж без объяснения оставляет
 * человека наедине с догадкой: «слабо» это насколько и чья это вина.
 */
export function protectionHint(p: SecretProtection): string {
  switch (p) {
    case 'os':
      return ts('sec.osHint')
    case 'weak':
      return ts('sec.weakHint')
    case 'plain':
      return ts('sec.plainHint')
    default:
      return ''
  }
}

/** Нужно ли предупреждать: всё, кроме «в хранилище ОС» и «ключа нет». */
export function isProtectionRisky(p: SecretProtection): boolean {
  return p === 'weak' || p === 'plain'
}
