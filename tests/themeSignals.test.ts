import { describe, expect, it } from 'vitest'
import { getThemes } from '@/features/themes/themes'
import '@/features/themes/themeDawn'

/**
 * Два цвета, которые НЕЛЬЗЯ путать.
 *
 * Акцент в Заре означает «сюда уйдёт Enter» — то есть одобрение запуска
 * команды, которую предложил агент. Danger означает противоположное:
 * «осторожно», «отклонить», «ошибка». Если они читаются как один цвет, самый
 * дорогой вопрос интерфейса решается чтением текста, а не взглядом.
 *
 * Мерить глазом это нельзя, поэтому мерим числами: контраст между самими
 * сигналами и разница тона. Пороги невысокие нарочно — это отсечка «цвета
 * различимы вообще», а не оценка красоты.
 *
 * Известное расхождение: у большинства прежних тем акцент — тот же флажный
 * красный, что и danger (у «Космоса» контраст 1.25 при разнице тона в ОДИН
 * градус). Это часть советской палитры и переделывается только вместе с
 * решением о смене направления, поэтому проверка пока стоит на рассветной паре
 * — том направлении, где правило заявлено.
 */
const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function luminance(hex: string): number {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function hue(hex: string): number {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  if (!d) return 0
  const raw = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (raw * 60 + 360) % 360
}

function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}

const DAWN = ['zarya-blue-hour', 'zarya-golden-hour']

describe('рассветные темы: сигналы различимы', () => {
  for (const id of DAWN) {
    const theme = getThemes().find((t) => t.id === id)

    it(`${id}: акцент и опасность — разные цвета`, () => {
      expect(theme, `тема ${id} не зарегистрирована`).toBeDefined()
      const { accent, danger } = theme!.ui
      // 1.5 — примерно та граница, за которой два пятна перестают сливаться на
      // периферии зрения. У «Космоса» здесь 1.25.
      expect(contrast(accent, danger), `${id}: контраст сигналов`).toBeGreaterThanOrEqual(1.5)
      // Тон нужен отдельно: контраст сам по себе даёт «тёмный красный против
      // светлого красного», а это по-прежнему один цвет.
      expect(hueGap(accent, danger), `${id}: разница тона`).toBeGreaterThanOrEqual(30)
    })

    it(`${id}: акцент читается на своём фоне`, () => {
      const { accent, danger, bg } = theme!.ui
      // Акцент попадает в подпись шапки панели — самый мелкий цветной текст в
      // окне. На светлой теме «красивая» светлая охра давала 3.8.
      expect(contrast(accent, bg), `${id}: акцент к фону`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(danger, bg), `${id}: опасность к фону`).toBeGreaterThanOrEqual(4.5)
    })

    it(`${id}: ANSI-цвета остались собой`, () => {
      // Программы рассчитывают на имена цветов: синий обязан быть синим, а не
      // «рассветным». Проверяется тон, а не оттенок вкуса.
      const t = theme!.terminal
      expect(hue(t.blue), `${id}: синий`).toBeGreaterThan(180)
      expect(hue(t.blue), `${id}: синий`).toBeLessThan(260)
      expect(hue(t.green), `${id}: зелёный`).toBeGreaterThan(80)
      expect(hue(t.green), `${id}: зелёный`).toBeLessThan(180)
      // Читаемость вывода на фоне терминала: логи читают часами.
      expect(contrast(t.foreground, t.background), `${id}: текст терминала`).toBeGreaterThan(7)
    })
  }
})
