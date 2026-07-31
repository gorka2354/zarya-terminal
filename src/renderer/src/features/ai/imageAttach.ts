import {
  IMAGE_MAX_BYTES,
  checkImageSource,
  fitSize,
  needsResize,
  type ImageAttachment,
  type ImageMime
} from '@shared/images'
import { uid } from '@/lib/uid'

/**
 * Превращение вставленного файла во вложение.
 *
 * Декодируем и уменьшаем декодером Chromium прямо в окне, куда байты и так
 * попали. Тащить sharp или jimp в главный процесс ради ресайза значило бы
 * завести новую нативную библиотеку — то есть новую поверхность уязвимостей —
 * там, где своя уже есть.
 *
 * Картинка НИКОГДА не усекается по байтам: для текста «влезло сколько влезло»
 * терпимо, для картинки это битый файл. Не помещается после уменьшения —
 * честный отказ.
 */

const THUMB_SIDE = 72

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  // По кускам: btoa на строке в мегабайты упирается в предел аргументов.
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  hasAlpha: boolean
): Promise<{ blob: Blob; mediaType: ImageMime }> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('нет 2d-контекста')
  ctx.drawImage(bitmap, 0, 0, width, height)
  // WebP для картинок с прозрачностью, JPEG для непрозрачных: он заметно легче
  // на скриншотах, а прозрачность на них не нужна.
  const type = hasAlpha ? 'image/webp' : 'image/jpeg'
  const blob = await canvas.convertToBlob({ type, quality: 0.86 })
  return { blob, mediaType: type as ImageMime }
}

export async function fileToAttachment(
  file: File
): Promise<{ ok: true; att: ImageAttachment } | { ok: false; reason: string }> {
  // Голова файла — до чтения целиком: и формат, и защита от «бомбы».
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const check = checkImageSource(file.size, head)
  if (!check.ok) return check

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { ok: false, reason: 'не удалось прочитать изображение' }
  }

  const hasAlpha = check.mediaType === 'image/png' || check.mediaType === 'image/webp'
  let mediaType: ImageMime = check.mediaType
  let bytes = file.size
  let width = bitmap.width
  let height = bitmap.height
  let data: string

  if (needsResize(width, height, bytes)) {
    const fit = fitSize(width, height)
    const { blob, mediaType: mt } = await encode(bitmap, fit.width, fit.height, hasAlpha)
    if (blob.size > IMAGE_MAX_BYTES) {
      bitmap.close()
      return {
        ok: false,
        reason: 'картинка слишком тяжёлая даже после уменьшения — сохраните её меньше'
      }
    }
    mediaType = mt
    bytes = blob.size
    width = fit.width
    height = fit.height
    data = await toBase64(blob)
  } else {
    data = await toBase64(file)
  }

  // Миниатюра для чипа: полный base64 в DOM на каждый ререндер не нужен.
  let thumb: string | undefined
  try {
    const t = fitSize(width, height)
    const k = THUMB_SIDE / Math.max(t.width, t.height)
    const tw = Math.max(1, Math.round(t.width * k))
    const th = Math.max(1, Math.round(t.height * k))
    const { blob } = await encode(bitmap, tw, th, hasAlpha)
    thumb = `data:image/webp;base64,${await toBase64(blob)}`
  } catch {
    // Превью — украшение: без него вложение всё равно работает.
  }
  bitmap.close()

  return {
    ok: true,
    att: {
      id: uid('img'),
      mediaType,
      data,
      bytes,
      width,
      height,
      name: file.name || undefined,
      thumb
    }
  }
}

/** Картинки из буфера обмена или перетаскивания — в порядке, в котором их дали. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue
    const f = item.getAsFile()
    if (f) out.push(f)
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) out.push(f)
  return out
}
