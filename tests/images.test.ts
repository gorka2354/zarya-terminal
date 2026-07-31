import { describe, expect, it } from 'vitest'
import {
  IMAGE_MAX_PER_MSG,
  IMAGE_MAX_SIDE,
  IMAGE_SRC_MAX_BYTES,
  canAcceptMore,
  checkImageSource,
  fitSize,
  imagePlaceholder,
  needsResize,
  sniffImageMime,
  type ImageAttachment
} from '@shared/images'
import { setLangProvider } from '@shared/lang'

/**
 * Вставка картинки — первое место, где в приложение попадают чужие БАЙТЫ, а не
 * текст. Всё, что здесь проверяется, ломается тихо: формат, названный буфером
 * обмена, может не совпасть с содержимым, а «немного не влезло» для картинки
 * означает битый файл, а не усечённый текст.
 */
const head = (...bytes: number[]): Uint8Array => {
  const a = new Uint8Array(16)
  bytes.forEach((b, i) => (a[i] = b))
  return a
}
const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG = head(0xff, 0xd8, 0xff, 0xe0)
const GIF = head(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
const WEBP = head(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)
const SVG = head(0x3c, 0x73, 0x76, 0x67, 0x20) // <svg
const BMP = head(0x42, 0x4d)

const att = (bytes: number): ImageAttachment => ({
  id: 'a' + bytes,
  mediaType: 'image/png',
  data: '',
  bytes,
  width: 100,
  height: 100
})

describe('формат по байтам', () => {
  it('узнаёт четыре формата, которые принимает API', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(GIF)).toBe('image/gif')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
  })

  it('SVG и BMP отклоняет', () => {
    // SVG это разметка: в превью она стала бы чужим кодом, а API его и не примет.
    expect(sniffImageMime(SVG)).toBeNull()
    expect(sniffImageMime(BMP)).toBeNull()
  })

  it('обрывок не считается картинкой', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull()
  })

  it('верит байтам, а не заявленному типу', () => {
    // Буфер обмена и dataTransfer — недоверенный источник: там может стоять
    // image/png на чём угодно. Отправить чужие байты под нашим media_type значит
    // получить отказ там, где мы уже сказали «принято».
    const r = checkImageSource(1000, SVG)
    expect(r.ok).toBe(false)
  })
})

describe('пределы приёма', () => {
  it('слишком большой файл отклоняется ДО декодирования', () => {
    const r = checkImageSource(IMAGE_SRC_MAX_BYTES + 1, PNG)
    expect(r.ok).toBe(false)
    // Отказ переведён на оба языка: подставленный вместо текста ключ выглядел бы
    // в интерфейсе как «img.tooBig» — сломано, но незаметно для типов.
    if (!r.ok) expect(r.reason).toMatch(/\d+ MB/)
    setLangProvider(() => 'ru')
    const ru = checkImageSource(IMAGE_SRC_MAX_BYTES + 1, PNG)
    if (!ru.ok) expect(ru.reason).toMatch(/\d+ МБ/)
    setLangProvider(() => 'en')
  })

  it('нормальный PNG проходит', () => {
    const r = checkImageSource(500_000, PNG)
    expect(r).toEqual({ ok: true, mediaType: 'image/png' })
  })

  it('пятая картинка получает явный отказ, а не тихое отбрасывание', () => {
    const four = Array.from({ length: IMAGE_MAX_PER_MSG }, () => att(1000))
    const r = canAcceptMore(four, 1000)
    expect(r.ok).toBe(false)
  })

  it('суммарный вес тоже ограничен', () => {
    const heavy = [att(7 * 1024 * 1024)]
    expect(canAcceptMore(heavy, 2 * 1024 * 1024).ok).toBe(false)
    expect(canAcceptMore(heavy, 100).ok).toBe(true)
  })
})

describe('нормализация размера', () => {
  it('большая сторона требует уменьшения', () => {
    expect(needsResize(4000, 2000, 1000)).toBe(true)
    expect(needsResize(800, 600, 1000)).toBe(false)
  })

  it('тяжёлый файл требует уменьшения даже при малой стороне', () => {
    expect(needsResize(800, 600, 10 * 1024 * 1024)).toBe(true)
  })

  it('пропорции сохраняются', () => {
    const r = fitSize(4000, 2000)
    expect(Math.max(r.width, r.height)).toBe(IMAGE_MAX_SIDE)
    expect(r.width / r.height).toBeCloseTo(2, 2)
  })

  it('маленькую картинку не растягиваем', () => {
    expect(fitSize(320, 200)).toEqual({ width: 320, height: 200 })
  })
})

describe('плейсхолдер', () => {
  it('нумерация с единицы и по порядку', () => {
    // Модель видит ссылку там, где человек вставил картинку, а блоки идут следом.
    expect(imagePlaceholder(0)).toBe('[Image #1]')
    expect(imagePlaceholder(3)).toBe('[Image #4]')
    setLangProvider(() => 'ru')
    expect(imagePlaceholder(0)).toBe('[Изображение #1]')
    setLangProvider(() => 'en')
  })
})
