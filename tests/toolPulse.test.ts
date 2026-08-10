import { describe, expect, it } from 'vitest'
import { notePulse, pulseAlive, pulseSilence, PULSE_QUIET_FLOOR_MS } from '@shared/toolPulse'

/**
 * Порог тишины — единственное место, где Заря может соврать про чужой процесс.
 *
 * Сказать «пульса нет» там, где его и не обещали, — объявить смерть по
 * незнанию. Промолчать там, где сердцебиение шло и оборвалось, — оставить
 * человека ждать вывода, которого не будет. Оба конца проверяются здесь, а не
 * на живом движке: дождаться настоящего зависания в прогоне нечем.
 */
describe('pulseSilence — когда о тишине можно говорить', () => {
  it('пульса не было вовсе — молчим: движок про этот вызов и не рассказывал', () => {
    expect(pulseSilence(undefined, 10_000_000)).toBeNull()
  })

  it('пульс был ровно один — молчим: ритм не с чем сравнить', () => {
    const p = notePulse(undefined, 0, 1)
    expect(p.beats).toBe(1)
    expect(pulseSilence(p, 10 * 60_000)).toBeNull()
  })

  it('частый ритм: полминуты тишины ещё не новость, минута — уже да', () => {
    // Пульс раз в секунду: наблюдённый промежуток мал, работает нижний порог.
    let p = notePulse(undefined, 0, 0)
    p = notePulse(p, 1_000, 1)
    p = notePulse(p, 2_000, 2)
    expect(pulseSilence(p, 2_000 + PULSE_QUIET_FLOOR_MS)).toBeNull()
    expect(pulseSilence(p, 2_000 + PULSE_QUIET_FLOOR_MS + 1)).toBe(PULSE_QUIET_FLOOR_MS + 1)
  })

  it('редкий ритм поднимает порог: тревога не срабатывает на обычный промежуток', () => {
    // Пульс раз в минуту — тишина в минуту здесь норма, а не пропажа.
    let p = notePulse(undefined, 0, 0)
    p = notePulse(p, 60_000, 60)
    expect(pulseSilence(p, 120_000)).toBeNull()
    // Втрое дольше наблюдённого — уже пропажа.
    expect(pulseSilence(p, 60_000 + 3 * 60_000 + 1)).toBe(3 * 60_000 + 1)
  })

  it('порог считается по САМОМУ ДЛИННОМУ промежутку, а не по последнему', () => {
    let p = notePulse(undefined, 0, 0)
    p = notePulse(p, 90_000, 90) // длинный промежуток — он и задаёт норму
    p = notePulse(p, 90_500, 91) // короткий следом не должен ужесточать порог
    expect(p.gapMax).toBe(90_000)
    expect(pulseSilence(p, 90_500 + 200_000)).toBeNull()
  })

  it('часы дёрнулись назад — промежуток не измерение, а мусор', () => {
    let p = notePulse(undefined, 10_000, 1)
    p = notePulse(p, 5_000, 2)
    expect(p.gapMax).toBe(0)
    expect(p.beats).toBe(2)
  })
})

describe('notePulse — что накапливается', () => {
  it('время движка берётся у движка, а не считается своё', () => {
    let p = notePulse(undefined, 0, 4)
    p = notePulse(p, 1_000, 9)
    expect(p.elapsedSec).toBe(9)
  })

  it('повтор не залипает: движок называет его заново на каждом кадре', () => {
    let p = notePulse(undefined, 0, 1, { attempt: 2, max: 3 })
    expect(p.retry).toEqual({ attempt: 2, max: 3 })
    p = notePulse(p, 1_000, 2)
    expect(p.retry).toBeUndefined()
  })
})

describe('pulseAlive — обратная сторона того же вопроса', () => {
  it('без пульса «жив» не утверждается: молчание это незнание, а не жизнь', () => {
    expect(pulseAlive(undefined, 0)).toBe(false)
  })

  it('свежий пульс — жив', () => {
    const p = notePulse(notePulse(undefined, 0, 0), 1_000, 1)
    expect(pulseAlive(p, 2_000)).toBe(true)
  })

  it('пропавший пульс — уже не жив', () => {
    const p = notePulse(notePulse(undefined, 0, 0), 1_000, 1)
    expect(pulseAlive(p, 1_000 + PULSE_QUIET_FLOOR_MS + 1)).toBe(false)
  })
})
