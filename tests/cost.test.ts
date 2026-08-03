import { describe, expect, it } from 'vitest'
import { addCost, formatCost } from '@shared/cost'

/**
 * Деньги — то место, где округление читается как обещание. Проверяется, что
 * «не считали», «ноль» и «меньше цента» не сливаются в одно, потому что для
 * человека это три разных ответа.
 */
describe('накопление стоимости', () => {
  it('копит ход за ходом', () => {
    expect(addCost(undefined, 0.4)).toBeCloseTo(0.4)
    expect(addCost(0.4, 0.35)).toBeCloseTo(0.75)
  })

  it('мусор в ответе движка не портит сумму', () => {
    expect(addCost(0.5, undefined)).toBeCloseTo(0.5)
    expect(addCost(0.5, 'дорого')).toBeCloseTo(0.5)
    expect(addCost(0.5, NaN)).toBeCloseTo(0.5)
    expect(addCost(0.5, -1)).toBeCloseTo(0.5)
    expect(addCost(0.5, Infinity)).toBeCloseTo(0.5)
  })

  it('пока ничего не потрачено — цифры нет, а не ноль', () => {
    expect(addCost(undefined, undefined)).toBeUndefined()
    expect(addCost(undefined, 0)).toBeUndefined()
  })
})

describe('формат денег', () => {
  it('обычные суммы — до цента', () => {
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(1.5)).toBe('$1.50')
  })

  it('меньше цента не превращается в «бесплатно»', () => {
    // $0.00 читается как «денег не стоило», хотя это округление.
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0.0001)).toBe('<$0.01')
  })

  it('крупные суммы теряют лишнюю точность, а не смысл', () => {
    expect(formatCost(12.34)).toBe('$12.3')
    expect(formatCost(1234.5)).toBe('$1235')
  })

  it('нечего показывать — пустая строка', () => {
    expect(formatCost(undefined)).toBe('')
    expect(formatCost(0)).toBe('')
    expect(formatCost(NaN)).toBe('')
    expect(formatCost(-3)).toBe('')
  })
})
