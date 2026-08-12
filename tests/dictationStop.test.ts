import { describe, expect, it } from 'vitest'
import {
  dictationStop,
  NOISE_FLOOR,
  QUIET_MS,
  speechLevel,
  type StopDecision
} from '../src/shared/dictationStop'

/**
 * Диктовка обязана заканчиваться сама, когда её начали значком.
 *
 * Про это и был отчёт владельца: «микрофон вставляет слова только после второго
 * нажатия». Две причины, и обе проверяются здесь: залипший флаг удержания и
 * фиксированный порог речи, недостижимый для тихого микрофона.
 */

/** Прогнать несколько тиков подряд, как это делает таймер в строке ввода. */
const run = (
  levels: number[],
  heldByKey = false,
  stepMs = 100
): { stoppedAt: number | null; last: StopDecision } => {
  let s: StopDecision = { heard: false, peak: 0, quietSince: 0, stop: false }
  let now = 0
  for (const level of levels) {
    now += stepMs
    s = dictationStop({ ...s, level, now, heldByKey })
    if (s.stop) return { stoppedAt: now, last: s }
  }
  return { stoppedAt: null, last: s }
}

const речь = (n: number, громкость = 0.4): number[] => Array(n).fill(громкость)
const тишина = (n: number, шум = 0.01): number[] => Array(n).fill(шум)

describe('dictationStop', () => {
  it('запись значком останавливается после речи и паузы', () => {
    const r = run([...речь(10), ...тишина(30)])
    expect(r.stoppedAt).not.toBeNull()
    expect(r.stoppedAt! - 10 * 100).toBeGreaterThan(QUIET_MS)
  })

  it('ТИХИЙ микрофон тоже останавливается сам', () => {
    /*
     * Ровно тот случай, ради которого порог перестал быть константой. Пик 0.09
     * — ниже прежних 0.12, и со старым правилом «речь звучала» не выставлялось
     * НИКОГДА: автостоп молчал всю запись, а человек ждал и жал второй раз.
     */
    const r = run([...речь(10, 0.09), ...тишина(30, 0.005)])
    expect(r.stoppedAt).not.toBeNull()
  })

  it('очень тихий вход всё же не считается речью — это шум', () => {
    // Иначе гул вентилятора включал бы отсчёт, и запись обрывалась бы сама.
    expect(run([...тишина(20, NOISE_FLOOR - 0.005), ...тишина(40, 0)]).stoppedAt).toBeNull()
  })

  it('удержание клавиши отменяет автостоп — пауза посреди фразы это не конец', () => {
    expect(run([...речь(10), ...тишина(100)], true).stoppedAt).toBeNull()
  })

  it('молчание ДО первого слова не останавливает ничего', () => {
    expect(run(тишина(200)).stoppedAt).toBeNull()
  })

  it('пауза короче порога фразу не обрывает', () => {
    const пауза = Math.floor(QUIET_MS / 100) - 3
    expect(run([...речь(5), ...тишина(пауза), ...речь(5), ...тишина(2)]).stoppedAt).toBeNull()
  })

  it('счётчик тишины сбрасывается новой речью, а не копится через паузы', () => {
    const короткая = Math.floor(QUIET_MS / 100) - 2
    const r = run([
      ...речь(3),
      ...тишина(короткая),
      ...речь(3),
      ...тишина(короткая),
      ...речь(3),
      ...тишина(короткая)
    ])
    expect(r.stoppedAt).toBeNull()
  })

  it('порог считается от самого громкого места записи', () => {
    expect(speechLevel(0.8)).toBeCloseTo(0.4, 5)
    // У тихой записи порог опускается…
    expect(speechLevel(0.1)).toBeCloseTo(0.05, 5)
    // …но не ниже пола против шума.
    expect(speechLevel(0.01)).toBe(NOISE_FLOOR)
  })

  it('пик не забывается между тиками', () => {
    const s1 = dictationStop({
      level: 0.6,
      heard: false,
      peak: 0,
      quietSince: 0,
      now: 100,
      heldByKey: false
    })
    expect(s1.peak).toBe(0.6)
    const s2 = dictationStop({ ...s1, level: 0.2, now: 200, heldByKey: false })
    // 0.2 против порога 0.3 — уже тишина, хотя вход не нулевой: громкая запись
    // задаёт свою планку.
    expect(s2.peak).toBe(0.6)
    expect(s2.quietSince).toBe(200)
  })

  it('момент начала тишины запоминается один раз', () => {
    const base = { heard: true, peak: 0.4, heldByKey: false }
    const first = dictationStop({ ...base, level: 0, quietSince: 0, now: 5000 })
    expect(first.quietSince).toBe(5000)
    const later = dictationStop({ ...base, level: 0, quietSince: first.quietSince, now: 6000 })
    expect(later.quietSince).toBe(5000)
    expect(later.stop).toBe(false)
    expect(dictationStop({ ...base, level: 0, quietSince: 5000, now: 6600 }).stop).toBe(true)
  })
})
