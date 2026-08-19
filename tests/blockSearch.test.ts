import { describe, expect, it } from 'vitest'
import { searchBlocks, SEARCH_DEPTH } from '@shared/blockSearch'

/**
 * Поиск по командам панели.
 *
 * ЗАВЕДЁН ПО РЕВЬЮ. Правила жили внутри обработчика запроса окна, и проверить
 * их было нечем: он тянет за собой хранилища, окно и мост. Ревью нашло там три
 * дефекта разом — отрывок без искомого, разбор всего вывода на массив строк и
 * отсутствие какой-либо проверки вообще. Теперь это чистая функция, и каждая
 * находка ниже закреплена своим случаем.
 */
const block = (id: string, command: string, output = ''): { id: string; command: string; output: string } => ({
  id,
  command,
  output
})

const opts = { hits: 5, cap: 200 }

describe('searchBlocks — что вообще считается совпадением', () => {
  it('находит в выводе и отдаёт совпавшую строку', () => {
    const out = searchBlocks(
      [block('b1', 'npm run build', 'ok\nError: connect ECONNREFUSED 127.0.0.1:5432\ndone')],
      'econnrefused',
      opts
    )
    expect(out).toHaveLength(1)
    expect(out[0].matches).toBe(1)
    expect(out[0].snippet).toBe('Error: connect ECONNREFUSED 127.0.0.1:5432')
  })

  it('регистр не различает: человек ищет строчными, лог кричит прописными', () => {
    expect(searchBlocks([block('b1', 'x', 'ECONNREFUSED')], 'econnrefused', opts)).toHaveLength(1)
    expect(searchBlocks([block('b1', 'x', 'econnrefused')], 'ECONNREFUSED', opts)).toHaveLength(1)
  })

  it('совпало в КОМАНДЕ, а в выводе нет — отрывку взяться неоткуда', () => {
    /*
     * Ноль здесь значимое число: агент должен видеть разницу между «нашлось в
     * выводе» и «нашлось в самой команде». Выдуманный отрывок был бы хуже
     * пустого поля.
     */
    const out = searchBlocks([block('b1', 'git push --force', 'everything up-to-date')], 'force', opts)
    expect(out[0].matches).toBe(0)
    expect(out[0].snippet).toBeUndefined()
  })

  it('не нашлось нигде — блока в ответе нет вовсе', () => {
    expect(searchBlocks([block('b1', 'ls', 'a\nb')], 'zzz', opts)).toEqual([])
  })

  it('пустой запрос — не поиск', () => {
    // Иначе пробел в аргументе превратил бы список в «совпавшие с пробелом».
    expect(searchBlocks([block('b1', 'ls', 'a b')], '   ', opts)).toEqual([])
    expect(searchBlocks([block('b1', 'ls', 'a b')], '', opts)).toEqual([])
  })
})

describe('searchBlocks — считаем СТРОКИ, а не вхождения', () => {
  it('два вхождения в одной строке — одна совпавшая строка', () => {
    const out = searchBlocks([block('b1', 'x', 'err err\nтихо')], 'err', opts)
    expect(out[0].matches).toBe(1)
  })

  it('в разных строках — по одной за каждую', () => {
    const out = searchBlocks([block('b1', 'x', 'err\nтихо\nerr\nerr')], 'err', opts)
    expect(out[0].matches).toBe(3)
  })

  it('последняя строка без перевода в конце тоже считается', () => {
    expect(searchBlocks([block('b1', 'x', 'тихо\nerr')], 'err', opts)[0].matches).toBe(1)
  })
})

describe('searchBlocks — отрывок вокруг совпадения, а не от начала строки', () => {
  /*
   * Ревью: `slice(0, 200)` на однострочном JSON отдавал агенту двести знаков,
   * в которых искомого нет вовсе, — и он читал это как «нашлось вот это».
   */
  const long = `${'x'.repeat(1000)}ECONNREFUSED${'y'.repeat(1000)}`

  it('искомое ВНУТРИ отрывка, даже если оно за тысячу знаков от начала', () => {
    const out = searchBlocks([block('b1', 'x', long)], 'econnrefused', opts)
    expect(out[0].snippet).toContain('ECONNREFUSED')
  })

  it('обрезка видна с обеих сторон', () => {
    const s = out1()
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })

  it('длина отрывка держится в пределе', () => {
    // Плюс два многоточия — они и есть признак обрезки.
    expect(out1().length).toBeLessThanOrEqual(opts.cap + 2)
  })

  it('короткая строка не режется и многоточий не получает', () => {
    const s = searchBlocks([block('b1', 'x', 'коротко и по делу err')], 'err', opts)[0].snippet
    expect(s).toBe('коротко и по делу err')
  })

  it('совпадение в начале длинной строки — многоточие только справа', () => {
    const s = searchBlocks([block('b1', 'x', `err${'y'.repeat(500)}`)], 'err', opts)[0].snippet ?? ''
    expect(s.startsWith('…')).toBe(false)
    expect(s.endsWith('…')).toBe(true)
  })

  it('перевод строки в отрывок не попадает', () => {
    // Многострочным отрывком в чужом промпте рисуют что угодно, включая
    // поддельный конец сообщения.
    const s = searchBlocks([block('b1', 'x', 'до\nтут err внутри\nпосле')], 'err', opts)[0].snippet
    expect(s).toBe('тут err внутри')
  })

  function out1(): string {
    return searchBlocks([block('b1', 'x', long)], 'econnrefused', opts)[0].snippet ?? ''
  }
})

describe('searchBlocks — пределы, и они не на честном слове', () => {
  const many = Array.from({ length: 40 }, (_, i) => block(`b${i}`, 'cmd', 'err here'))

  it('больше `hits` блоков не возвращается', () => {
    expect(searchBlocks(many, 'err', { hits: 5, cap: 200 })).toHaveLength(5)
  })

  it('возвращаются ПОСЛЕДНИЕ совпавшие, в порядке ленты', () => {
    const out = searchBlocks(many, 'err', { hits: 3, cap: 200 })
    expect(out.map((m) => m.id)).toEqual(['b37', 'b38', 'b39'])
  })

  it('вглубь смотрим не дальше названной границы', () => {
    /*
     * Хранилище держит сотни блоков по сотне килобайт вывода, а проход идёт
     * синхронно в потоке окна, пока главный процесс ждёт ответа с таймаутом.
     * «Где я это видел» — вопрос про недавнее.
     */
    const deep = [
      block('старый', 'cmd', 'ИСКОМОЕ'),
      ...Array.from({ length: SEARCH_DEPTH + 5 }, (_, i) => block(`b${i}`, 'cmd', 'тихо'))
    ]
    expect(searchBlocks(deep, 'ИСКОМОЕ', opts)).toEqual([])
    expect(searchBlocks(deep, 'ИСКОМОЕ', { ...opts, depth: deep.length })).toHaveLength(1)
  })

  it('мусор вместо блоков не роняет', () => {
    expect(searchBlocks([], 'err', opts)).toEqual([])
    expect(searchBlocks([block('b1', 'cmd')], 'err', opts)).toEqual([])
  })
})
