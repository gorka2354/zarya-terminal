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
      return 'Ключ в хранилище ОС'
    case 'weak':
      return 'Ключ защищён слабо'
    case 'plain':
      return 'Ключ открытым текстом'
    default:
      return 'Ключ не задан'
  }
}

/**
 * Объяснение — почему так и что с этим делать. Бейдж без объяснения оставляет
 * человека наедине с догадкой: «слабо» это насколько и чья это вина.
 */
export function protectionHint(p: SecretProtection): string {
  switch (p) {
    case 'os':
      return 'Зашифрован средствами операционной системы (DPAPI / Keychain / keyring) и расшифровывается только под вашей учётной записью.'
    case 'weak':
      return 'Система не предоставила настоящего хранилища (на Linux — нет keyring). Шифрование формальное: тот, кто прочитает файл, прочитает и ключ. Установите gnome-keyring или kwallet, затем сохраните ключ заново.'
    case 'plain':
      return 'Ключ записан в secrets.json как обычный текст (base64 — это не шифрование). Любой процесс с доступом к вашим файлам его прочитает. Сохраните ключ заново, когда хранилище ОС станет доступно.'
    default:
      return ''
  }
}

/** Нужно ли предупреждать: всё, кроме «в хранилище ОС» и «ключа нет». */
export function isProtectionRisky(p: SecretProtection): boolean {
  return p === 'weak' || p === 'plain'
}
