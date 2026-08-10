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

/*
 * КАРТИНКА ОТ ИНСТРУМЕНТА — это другая история, чем вложение человека.
 *
 * Человек прикладывает четыре скриншота за ход и знает, зачем. MCP-сервер
 * браузера возвращает скриншот на КАЖДЫЙ вызов, и за час работы их набегают
 * сотни. Поэтому пределы здесь свои и жёстче, а живут такие картинки только в
 * открытой ленте: в файл беседы они не попадают вовсе.
 *
 * Причина не в экономии места, а в честности механики. Беседа переписывается на
 * диск целиком раз в несколько сот миллисекунд; сотня скриншотов превратила бы
 * каждое сохранение в мегабайты, и Заря, обещающая не оставлять мусора,
 * оставляла бы его больше всех.
 */

/** Одна картинка, вернувшаяся из инструмента. `data` — base64 без префикса. */
export interface ToolImage {
  mediaType: ImageMime
  data: string
  bytes: number
}

/** Больше этого одну картинку не берём: скриншот столько не весит, а бомба — да. */
export const TOOL_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** Сколько картинок принимаем от ОДНОГО вызова. */
export const TOOL_IMAGE_MAX_PER_RESULT = 4
/** Сколько всего держим в памяти открытой беседы. Дальше вытесняем старые. */
export const TOOL_IMAGE_BUDGET_BYTES = 16 * 1024 * 1024
/**
 * Предел по ПИКСЕЛЯМ, а не по байтам.
 *
 * Сжатая картинка врёт о своём весе: однотонный PNG 30000×30000 занимает
 * несколько сотен килобайт и укладывается в любой байтовый предел, а в памяти
 * окна разворачивается в три с половиной гигабайта — окно просто умирает. Байты
 * защищают от большого файла, пиксели — от маленького файла с большим
 * содержимым, и нужны оба.
 *
 * 40 мегапикселей — вчетверо больше самого большого мыслимого скриншота
 * (5120×2880 ≈ 15 Мп): предел, который не встретит честная картинка.
 */
export const TOOL_IMAGE_MAX_PIXELS = 40_000_000

/**
 * Сколько байт в строке base64. Считаем по длине, а не декодированием: длина
 * известна сразу, а декодировать ради размера — это и есть та самая распаковка,
 * от которой предел и защищает.
 */
export function base64Bytes(data: string): number {
  const len = data.length
  if (!len) return 0
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((len * 3) / 4) - pad)
}

/**
 * Размеры картинки по её ЗАГОЛОВКУ, без декодирования.
 *
 * Ровно то, чего не хватает байтовому пределу: сжатая картинка не говорит о
 * своём размере в памяти ничего, а нам надо отказать ДО того, как браузер
 * начнёт её разворачивать.
 *
 * `null` — размеров не нашли. Это не «плохая картинка»: у JPEG заголовок может
 * лежать за пределами тех байтов, что нам дали. Решение по такому — на стороне
 * вызывающего, и молчание тут честнее выдуманного числа.
 */
export function imageSize(head: Uint8Array): { width: number; height: number } | null {
  const b = head
  const be32 = (i: number): number => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]
  const le16 = (i: number): number => b[i] | (b[i + 1] << 8)
  const be16 = (i: number): number => (b[i] << 8) | b[i + 1]

  // PNG: IHDR идёт первым чанком, ширина и высота — байты 16..23.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: be32(16) >>> 0, height: be32(20) >>> 0 }
  }
  // GIF: логический экран — два little-endian слова сразу за подписью.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: le16(6), height: le16(8) }
  }
  // WEBP: три вида блока, у каждого свои места под размеры.
  if (
    b.length >= 30 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (kind === 'VP8 ' && b.length >= 30) {
      return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    }
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8X' && b.length >= 30) {
      return {
        width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
        height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
      }
    }
    return null
  }
  // JPEG: идём по маркерам до кадра (SOFn). Заголовок бывает далеко, и если
  // данных не хватило — честно возвращаем null.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      // SOF0..SOF15, кроме DHT (c4), JPGA (c8) и DAC (cc) — они не кадры.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: be16(i + 5), width: be16(i + 7) }
      }
      const len = be16(i + 2)
      if (len < 2) return null
      i += 2 + len
    }
    return null
  }
  return null
}

/**
 * Уложить картинки беседы в бюджет памяти, вытесняя самые старые.
 *
 * Порядок ключей в объекте — порядок вставки, то есть порядок вызовов: первым
 * уходит то, что человек уже пролистал. Карточка вытесненного вызова скажет об
 * этом словами, а не покажет пустоту.
 */
export function fitToolImages(
  current: Record<string, ToolImage[]> | undefined,
  id: string,
  images: ToolImage[],
  budget = TOOL_IMAGE_BUDGET_BYTES
): Record<string, ToolImage[]> {
  const next: Record<string, ToolImage[]> = { ...current, [id]: images }
  let total = 0
  for (const list of Object.values(next)) for (const img of list) total += img.bytes
  // Свежий вызов не вытесняем никогда: показать надо именно его, даже если он
  // один съедает весь бюджет.
  for (const key of Object.keys(next)) {
    if (total <= budget) break
    if (key === id) continue
    for (const img of next[key]) total -= img.bytes
    delete next[key]
  }
  return next
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
