import { describe, expect, it } from 'vitest'
import { EN, RU } from '@shared/i18n'

/**
 * Два словаря должны совпадать по составу ключей.
 *
 * Пропущенный перевод не падает и не подсвечивается: интерфейс просто
 * показывает ключ (`rw.mark.willDelete`) вместо фразы — и делает это ровно там,
 * где человек читает предупреждение о необратимом. Проверять глазами каждый
 * новый ключ бессмысленно, поэтому проверяет тест.
 */
describe('словари RU и EN', () => {
  const ru = Object.keys(RU).sort()
  const en = Object.keys(EN).sort()

  it('совпадают по набору ключей', () => {
    expect(ru.filter((k) => !(k in EN))).toEqual([])
    expect(en.filter((k) => !(k in RU))).toEqual([])
  })

  it('ни одна строка не пуста', () => {
    // Пустая строка — это тот же пропуск, только незаметный: место под текст
    // есть, текста нет.
    expect(ru.filter((k) => !String(RU[k]).trim())).toEqual([])
    expect(en.filter((k) => !String(EN[k]).trim())).toEqual([])
  })

  it('подстановки в переводе те же, что в оригинале', () => {
    // «{n}» в русском и «{count}» в английском — это молча сломанная строка:
    // подставлять будет нечего, и человек увидит фигурные скобки.
    const holes = (s: string): string[] => (String(s).match(/\{\w+\}/g) ?? []).sort()
    const bad = ru.filter((k) => holes(RU[k]).join() !== holes(EN[k]).join())
    expect(bad).toEqual([])
  })
})
