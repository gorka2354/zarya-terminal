/**
 * Вставка изображений: типы и пределы — одно место правды.
 *
 * Пороги здесь наши, а не подсмотренные: у Claude Code они зашиты в бинарник и в
 * типах SDK не видны. Взяты из документированных лимитов Vision, и лежат вместе,
 * чтобы не расползлись по рендереру, драйверу и главному процессу — расползшийся
 * предел это предел, который где-то не проверяется.
 */

import { ts } from './lang'

/**
 * Что принимает сам API Anthropic (Base64ImageSource) — шире нельзя даже при
 * желании. HEIC, BMP, TIFF и SVG отклоняем: первые три API не понимает, а SVG
 * это ещё и разметка, то есть вектор для чужого кода в превью.
 */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageMime = (typeof IMAGE_MIMES)[number]

/** Отказ ДО декодирования: распаковка «бомбы» съела бы память окна. */
export const IMAGE_SRC_MAX_BYTES = 25 * 1024 * 1024
/** Длинная сторона после нормализации — предел, выше которого модель всё равно ужимает. */
export const IMAGE_MAX_SIDE = 1568
/** Байты после нормализации. base64 раздувает на треть, отсюда запас до 5 МБ. */
export const IMAGE_MAX_BYTES = Math.round(3.75 * 1024 * 1024)
/** Сколько картинок за один ход и сколько всего — чтобы один ход не съел контекст. */
export const IMAGE_MAX_PER_MSG = 4
export const IMAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** Вложение, готовое к отправке. `data` — base64 без префикса data:. */
export interface ImageAttachment {
  id: string
  mediaType: ImageMime
  data: string
  bytes: number
  width: number
  height: number
  /** Имя файла, если вставляли перетаскиванием, — для подписи чипа. */
  name?: string
  /** Маленькое превью для чипа: полный base64 в DOM на каждый ререндер не нужен. */
  thumb?: string
}

/**
 * Формат по первым байтам, а не по тому, что сказал буфер обмена.
 *
 * `file.type` из clipboardData и dataTransfer приходит из недоверенного места:
 * страница или чужое приложение может назвать что угодно. Отправить в API байты
 * под чужим media_type — получить отказ там, где мы обещали «приняли».
 */
export function sniffImageMime(head: Uint8Array): ImageMime | null {
  const b = head
  if (b.length < 12) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // GIF87a / GIF89a
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  // WEBP: RIFF....WEBP
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp'
  return null
}

/** Почему вложение отклонено — текстом, который можно показать человеку. */
export type ImageReject = { ok: false; reason: string }

/**
 * Проверки, которые делаются ДО декодирования: размер и формат. Отдельно от
 * работы с картинкой, чтобы их можно было проверить тестом без браузера.
 */
export function checkImageSource(
  size: number,
  head: Uint8Array
): { ok: true; mediaType: ImageMime } | ImageReject {
  if (size > IMAGE_SRC_MAX_BYTES) {
    return {
      ok: false,
      reason: ts('img.tooBig', {
        mb: Math.round(size / 1048576),
        max: Math.round(IMAGE_SRC_MAX_BYTES / 1048576)
      })
    }
  }
  const mime = sniffImageMime(head)
  if (!mime) {
    return { ok: false, reason: ts('img.badType') }
  }
  return { ok: true, mediaType: mime }
}

/**
 * Влезает ли ещё одно вложение. Пятое отклоняем ЯВНО, а не выбрасываем молча:
 * человек должен узнать, что его картинка не поедет, до отправки.
 */
export function canAcceptMore(
  current: readonly ImageAttachment[],
  addBytes: number
): { ok: true } | ImageReject {
  if (current.length >= IMAGE_MAX_PER_MSG) {
    return { ok: false, reason: ts('img.tooMany', { n: IMAGE_MAX_PER_MSG }) }
  }
  const total = current.reduce((n, a) => n + a.bytes, 0) + addBytes
  if (total > IMAGE_MAX_TOTAL_BYTES) {
    return {
      ok: false,
      reason: ts('img.totalBig', { mb: Math.round(IMAGE_MAX_TOTAL_BYTES / 1048576) })
    }
  }
  return { ok: true }
}

/** Нужна ли нормализация: слишком большая сторона или слишком много байт. */
export function needsResize(width: number, height: number, bytes: number): boolean {
  return Math.max(width, height) > IMAGE_MAX_SIDE || bytes > IMAGE_MAX_BYTES
}

/** Во что уменьшать, сохраняя пропорции. */
export function fitSize(width: number, height: number): { width: number; height: number } {
  const side = Math.max(width, height)
  if (side <= IMAGE_MAX_SIDE) return { width, height }
  const k = IMAGE_MAX_SIDE / side
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/**
 * Плейсхолдер в тексте сообщения. Повторяет то, что делает CLI: модель видит
 * ссылку на картинку там, где человек её вставил, а сами блоки идут следом.
 * Нумерация локальна для сообщения — сквозной счётчик пришлось бы хранить, а
 * модель о нём всё равно ничего не знает.
 */
export function imagePlaceholder(index: number): string {
  return ts('img.placeholder', { n: index + 1 })
}
