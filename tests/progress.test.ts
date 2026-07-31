import { describe, expect, it } from 'vitest'
import { parseProgress, progressText } from '@shared/progress'

/**
 * Разбор строки скачивания. Здесь важнее не «поймать побольше», а не соврать:
 * полоса, нарисованная по случайным «100%» в чужом выводе, обещает человеку
 * происходящее, которого нет.
 */
describe('parseProgress — настоящие загрузчики', () => {
  it('git clone', () => {
    const p = parseProgress('Receiving objects:  35% (7/20), 12.4 MiB | 3.2 MiB/s')
    expect(p?.percent).toBe(35)
    expect(p?.speed).toBe('3.2 MiB/s')
    expect(p?.label).toBe('Receiving objects')
  })

  it('git resolving deltas', () => {
    const p = parseProgress('Resolving deltas: 100% (1234/1234), done.')
    expect(p?.percent).toBe(100)
    expect(p?.label).toBe('Resolving deltas')
  })

  it('pip', () => {
    const p = parseProgress(
      'Downloading numpy-1.26.0.whl (12.3 MB)\n   ━━━━━━━━━━━━━━━━ 8.1/12.3 MB 5.1 MB/s eta 0:00:01'
    )
    expect(p?.done).toBe('8.1')
    expect(p?.total).toBe('12.3 MB')
    expect(p?.speed).toBe('5.1 MB/s')
    expect(p?.eta).toBe('0:00:01')
  })

  it('wget', () => {
    const p = parseProgress('50%[=========>          ] 1,234,567   2.30MB/s    eta 3s')
    expect(p?.percent).toBe(50)
    expect(p?.speed).toBe('2.30MB/s')
    expect(p?.eta).toBe('3s')
  })

  it('docker pull', () => {
    const p = parseProgress('3f4a1b2c: Downloading [=====>       ]  12.3MB/45.6MB')
    expect(p?.done).toBe('12.3MB')
    expect(p?.total).toBe('45.6MB')
    expect(p?.label).toBe('Downloading')
  })

  it('дробный процент округляется', () => {
    expect(parseProgress('Downloading 42,7% of 100 MB')?.percent).toBe(43)
  })

  it('управляющие последовательности не мешают разбору', () => {
    const p = parseProgress('[0mReceiving objects: 100% (20/20), 12.4 MiB | 3.2 MiB/s[?25h')
    expect(p?.percent).toBe(100)
  })

  it('берётся ПОСЛЕДНЯЯ строка прогресса, а не первая', () => {
    // Загрузчик перерисовывает свою строку, и свежая всегда ниже: показать
    // верхнюю значило бы застыть на давно пройденных процентах.
    const out = [
      'Receiving objects:  10% (2/20), 1.0 MiB | 3.2 MiB/s',
      'Receiving objects:  80% (16/20), 9.9 MiB | 3.2 MiB/s'
    ].join('\n')
    expect(parseProgress(out)?.percent).toBe(80)
  })

  it('индикатор находится под курсорным мусором', () => {
    const out = 'Receiving objects:  64% (13/20), 8.0 MiB | 3.0 MiB/s\n\n\n'
    expect(parseProgress(out)?.percent).toBe(64)
  })
})

describe('parseProgress — молчит, когда прогресса нет', () => {
  it('процент сам по себе не считается скачиванием', () => {
    // Отчёт о покрытии — самый частый источник ложной полосы: проценты есть,
    // скачивания нет. Пара «42/42» без единиц объёма индикатором не считается.
    expect(parseProgress('Statements   : 100% ( 42/42 )')).toBeNull()
    expect(parseProgress('coverage: 100%')).toBeNull()
    expect(parseProgress('CPU 47% MEM 61%')).toBeNull()
  })

  it('обычный вывод не превращается в полосу', () => {
    expect(parseProgress('npm warn deprecated core-js@2.6.12')).toBeNull()
    expect(parseProgress('error TS2531: Object is possibly null')).toBeNull()
    expect(parseProgress('')).toBeNull()
  })

  it('процент за пределами шкалы отбрасывается', () => {
    // «переменная 300% CPU» в чужом выводе не должна давать полосу.
    expect(parseProgress('Downloading 300% 5 MB/s')?.percent ?? null).toBeNull()
  })

  it('абзац текста с процентом не индикатор', () => {
    const long =
      'Загрузка завершена на 50% и всё идёт по плану, '.repeat(6) + ' 3.2 MB/s'
    expect(parseProgress(long)).toBeNull()
  })
})

describe('progressText', () => {
  it('собирает подпись из того, что известно', () => {
    expect(
      progressText({ percent: 35, done: '12.4 MiB', total: '45.6 MiB', speed: '3.2 MiB/s' })
    ).toBe('35% · 12.4 MiB/45.6 MiB · 3.2 MiB/s')
  })

  it('пропускает то, чего нет', () => {
    expect(progressText({ percent: 7 })).toBe('7%')
    expect(progressText({ percent: null, done: '1 MB', total: '2 MB' })).toBe('1 MB/2 MB')
  })
})
