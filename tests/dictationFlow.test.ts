import { describe, expect, it } from 'vitest'
import {
  chunkOverdue,
  CHUNK_MS,
  dictationFlow,
  initialFlow,
  MAX_CHUNK_MS,
  NOISE_FLOOR,
  PHRASE_MS,
  speechLevel,
  type DictationMode,
  type FlowDecision
} from '../src/shared/dictationFlow'

/**
 * Три режима диктовки — три разных ожидания человека.
 *
 * Владелец сказал прямо: «нажал и говоришь, он сразу вводит; нажал ещё раз —
 * стоп». Проверяется именно это: в потоковом режиме пауза даёт ТЕКСТ, а не
 * конец записи, и запись переживает сколько угодно раздумий.
 */

const шаг = 100

/** Прогнать уровни через решение, собрав, что случилось и когда. */
const run = (
  levels: number[],
  mode: DictationMode,
  heldByKey = false
): { flushes: number[]; stopAt: number | null; last: FlowDecision } => {
  let s = initialFlow()
  let now = 0
  const flushes: number[] = []
  let d: FlowDecision = { ...s, flush: false, stop: false }
  for (const level of levels) {
    now += шаг
    d = dictationFlow(s, { level, now, mode, heldByKey })
    s = { heard: d.heard, peak: d.peak, quietSince: d.quietSince, chunkSince: d.chunkSince }
    if (d.flush) flushes.push(now)
    if (d.stop) return { flushes, stopAt: now, last: d }
  }
  return { flushes, stopAt: null, last: d }
}

const речь = (n: number, громкость = 0.4): number[] => Array(n).fill(громкость)
const тихо = (n: number, шум = 0.01): number[] => Array(n).fill(шум)

describe('режим «нажал и говорю» (stream)', () => {
  it('пауза отдаёт кусок на распознавание, а запись НЕ заканчивает', () => {
    const r = run([...речь(10), ...тихо(12), ...речь(10), ...тихо(12)], 'stream')
    expect(r.stopAt).toBeNull()
    // Два куска: по одному на каждую законченную фразу.
    expect(r.flushes).toHaveLength(2)
  })

  it('переживает долгое молчание — человек думает, а не закончил', () => {
    const r = run([...речь(10), ...тихо(300)], 'stream')
    expect(r.stopAt).toBeNull()
    expect(r.flushes).toHaveLength(1)
  })

  it('короткая заминка между словами кусок не режет', () => {
    const заминка = Math.floor(CHUNK_MS / шаг) - 3
    const r = run([...речь(5), ...тихо(заминка), ...речь(5), ...тихо(2)], 'stream')
    expect(r.flushes).toHaveLength(0)
  })

  it('после куска следующая фраза считается заново', () => {
    const r = run([...речь(6), ...тихо(10), ...речь(6), ...тихо(10)], 'stream')
    expect(r.flushes).toHaveLength(2)
    // Между кусками разрыв не меньше самой фразы: счётчики сброшены, а не
    // продолжены — иначе второй кусок ушёл бы почти сразу за первым.
    expect(r.flushes[1] - r.flushes[0]).toBeGreaterThan(CHUNK_MS)
  })

  it('молчание ДО первого слова ничего не отправляет', () => {
    expect(run(тихо(200), 'stream').flushes).toHaveLength(0)
  })
})

describe('режим «одна фраза» (phrase)', () => {
  it('тишина после речи заканчивает запись', () => {
    const r = run([...речь(10), ...тихо(30)], 'phrase')
    expect(r.stopAt).not.toBeNull()
    expect(r.stopAt! - 10 * шаг).toBeGreaterThan(PHRASE_MS)
  })

  it('кусками не режет — текст приходит один раз, в конце', () => {
    expect(run([...речь(10), ...тихо(30)], 'phrase').flushes).toHaveLength(0)
  })

  it('тихий микрофон тоже останавливается сам', () => {
    // Прежний фиксированный порог 0.12 такой вход не считал речью НИКОГДА.
    expect(run([...речь(10, 0.09), ...тихо(30, 0.005)], 'phrase').stopAt).not.toBeNull()
  })
})

describe('режим «зажал и говорю» (hold)', () => {
  it('тишина не заканчивает и не режет', () => {
    const r = run([...речь(10), ...тихо(100)], 'hold')
    expect(r.stopAt).toBeNull()
    expect(r.flushes).toHaveLength(0)
  })

  it('удержание клавиши перевешивает любой режим', () => {
    // Потерянный `keyup` больше не оставляет запись без конца: этот флаг
    // приходит от клавиши, а клик по значку его снимает.
    expect(run([...речь(10), ...тихо(100)], 'phrase', true).stopAt).toBeNull()
    expect(run([...речь(10), ...тихо(100)], 'stream', true).flushes).toHaveLength(0)
  })
})

describe('порог и предел куска', () => {
  it('порог считается от самого громкого места записи', () => {
    expect(speechLevel(0.8)).toBeCloseTo(0.4, 5)
    expect(speechLevel(0.1)).toBeCloseTo(0.05, 5)
    expect(speechLevel(0.01)).toBe(NOISE_FLOOR)
  })

  it('речь без пауз всё равно даёт текст — по пределу длины', () => {
    // Иначе говорящий без остановки не увидел бы ни слова до конца записи.
    const s = { heard: true, peak: 0.5, quietSince: 0, chunkSince: 1000 }
    expect(chunkOverdue(s, 1000 + MAX_CHUNK_MS - 1)).toBe(false)
    expect(chunkOverdue(s, 1000 + MAX_CHUNK_MS + 1)).toBe(true)
  })

  it('без начатого куска резать нечего', () => {
    expect(chunkOverdue(initialFlow(), 999_999)).toBe(false)
  })
})
