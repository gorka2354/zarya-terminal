import { describe, expect, it } from 'vitest'
import {
  KEEP_DAYS,
  MAX_PER_DAY,
  dayKey,
  idleSkills,
  noteUsage,
  observedDays,
  summarize
} from '@shared/skillUsage'

/**
 * История срабатываний: период, уборка и предел роста.
 *
 * Три обещания, которые здесь проверяются. (1) Период называется ЧЕСТНО: «ни
 * разу за 30 дней» на второй день наблюдения — неправда, за которую человек
 * выключит рабочий скилл. (2) Файл не растёт без предела — ни от времени, ни
 * от чужих данных. (3) «Кандидаты на выключение» — это именно кандидаты:
 * функция считает, но ничего не выключает.
 */
const DAY = 86_400_000
const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime()

describe('честность периода', () => {
  it('первый день наблюдения — это один день, а не ноль', () => {
    expect(observedDays(NOW, NOW)).toBe(1)
  })

  it('через сутки — два дня', () => {
    expect(observedDays(NOW - DAY, NOW)).toBe(2)
  })

  it('сводка не обещает больше, чем хранит', () => {
    // Наблюдаем «сто дней», но данных дальше KEEP_DAYS не осталось — говорить
    // «за 100 дней» значило бы обещать то, чего в файле нет.
    const file = { since: NOW - 100 * DAY, days: {} }
    expect(summarize(file, NOW).observedDays).toBe(KEEP_DAYS)
  })

  it('пустая история — один день, а не «ни разу за месяц»', () => {
    expect(summarize(undefined, NOW).observedDays).toBe(1)
  })
})

describe('запись и уборка', () => {
  it('первое срабатывание заводит наблюдение с этой минуты', () => {
    const f = noteUsage(undefined, ['review'], NOW)
    expect(f.since).toBe(NOW)
    expect(f.days[dayKey(NOW)]).toEqual({ review: 1 })
  })

  it('повторное срабатывание крутит счётчик, а не плодит записи', () => {
    let f = noteUsage(undefined, ['review'], NOW)
    f = noteUsage(f, ['review', 'review'], NOW)
    expect(f.days[dayKey(NOW)]).toEqual({ review: 3 })
  })

  it('начало наблюдения не переписывается позднейшей записью', () => {
    const f = noteUsage({ since: NOW - 5 * DAY, days: {} }, ['a'], NOW)
    expect(f.since).toBe(NOW - 5 * DAY)
  })

  it('дни старше предела выбрасываются', () => {
    let f = { since: NOW - 60 * DAY, days: {} as Record<string, Record<string, number>> }
    for (let i = 60; i >= 0; i--) f = noteUsage(f, ['a'], NOW - i * DAY)
    expect(Object.keys(f.days).length).toBe(KEEP_DAYS)
    // Остаться должны СВЕЖИЕ дни, а не первые попавшиеся.
    expect(Object.keys(f.days).sort().at(-1)).toBe(dayKey(NOW))
  })

  it('режем по КАЛЕНДАРЮ, а не по числу записей', () => {
    // Человек работает через день: тридцать записей растягиваются на два
    // месяца. Резать «последние 30 ключей» здесь — значит хранить данные
    // полугодовой давности и подписывать их как «за 30 дней».
    let f = { since: NOW - 90 * DAY, days: {} as Record<string, Record<string, number>> }
    for (let i = 90; i >= 0; i -= 3) f = noteUsage(f, ['sparse'], NOW - i * DAY)
    const keys = Object.keys(f.days).sort()
    expect(keys[0] >= dayKey(NOW - (KEEP_DAYS - 1) * DAY)).toBe(true)
    expect(keys.length).toBeLessThanOrEqual(KEEP_DAYS)
  })

  it('сводка не считает срабатывания старше объявленного периода', () => {
    // Скилл сработал 58 дней назад и с тех пор молчит. Сказать «3× за 30 дн.»
    // — неправда, и из-за неё он не попадёт в кандидаты на выключение.
    const f = {
      since: NOW - 90 * DAY,
      days: {
        [dayKey(NOW - 58 * DAY)]: { 'умер-в-июне': 3 },
        [dayKey(NOW - 2 * DAY)]: { 'живой': 1 }
      }
    }
    const s = summarize(f, NOW)
    expect(s.counts['умер-в-июне']).toBeUndefined()
    expect(s.counts['живой']).toBe(1)
  })

  it('и такой скилл становится кандидатом на выключение', () => {
    const f = {
      since: NOW - 90 * DAY,
      days: { [dayKey(NOW - 58 * DAY)]: { 'умер-в-июне': 3 } }
    }
    const { counts } = summarize(f, NOW)
    const r = idleSkills([{ name: 'умер-в-июне', tokens: 400, state: 'on' }], counts)
    expect(r.names).toEqual(['умер-в-июне'])
    expect(r.tokens).toBe(400)
  })

  it('чужие имена не раздувают файл без предела', () => {
    const many = Array.from({ length: MAX_PER_DAY + 50 }, (_, i) => `skill-${i}`)
    const f = noteUsage(undefined, many, NOW)
    expect(Object.keys(f.days[dayKey(NOW)]).length).toBe(MAX_PER_DAY)
  })

  it('но уже известному счётчик крутится и после переполнения', () => {
    const many = Array.from({ length: MAX_PER_DAY }, (_, i) => `skill-${i}`)
    let f = noteUsage(undefined, many, NOW)
    f = noteUsage(f, ['skill-0', 'новый-которого-нет'], NOW)
    expect(f.days[dayKey(NOW)]['skill-0']).toBe(2)
    expect(f.days[dayKey(NOW)]['новый-которого-нет']).toBeUndefined()
  })

  it('мусор вместо имени пропускается молча', () => {
    const f = noteUsage(undefined, ['  ', '', 'ok'], NOW)
    expect(f.days[dayKey(NOW)]).toEqual({ ok: 1 })
  })

  it('длинное имя обрезается — это имя папки, а не место для текста', () => {
    const f = noteUsage(undefined, ['x'.repeat(500)], NOW)
    expect(Object.keys(f.days[dayKey(NOW)])[0].length).toBe(80)
  })
})

describe('сводка', () => {
  it('складывает по дням', () => {
    let f = noteUsage(undefined, ['a', 'b'], NOW - 2 * DAY)
    f = noteUsage(f, ['a'], NOW - DAY)
    f = noteUsage(f, ['a'], NOW)
    expect(summarize(f, NOW).counts).toEqual({ a: 3, b: 1 })
  })

  it('дни — местные, а не UTC: «сегодня» у человека своё', () => {
    const lateEvening = new Date(2026, 7, 4, 23, 30).getTime()
    const nextMorning = new Date(2026, 7, 5, 0, 30).getTime()
    expect(dayKey(lateEvening)).not.toBe(dayKey(nextMorning))
  })
})

describe('кандидаты на выключение', () => {
  const items = [
    { name: 'dear-idle', tokens: 800, state: 'on' },
    { name: 'cheap-idle', tokens: 100, state: 'on' },
    { name: 'working', tokens: 500, state: 'on' },
    { name: 'already-off', tokens: 900, state: 'off' }
  ]

  it('это те, что не сработали ни разу, и их общая цена', () => {
    const r = idleSkills(items, { working: 4 })
    expect(r.names).toEqual(['dear-idle', 'cheap-idle'])
    expect(r.tokens).toBe(900)
  })

  it('выключённые не предлагаются — они уже ничего не стоят', () => {
    expect(idleSkills(items, {}).names).not.toContain('already-off')
  })

  it('когда работает всё, предлагать нечего', () => {
    const r = idleSkills(items, { 'dear-idle': 1, 'cheap-idle': 1, working: 1 })
    expect(r.names).toEqual([])
    expect(r.tokens).toBe(0)
  })
})
