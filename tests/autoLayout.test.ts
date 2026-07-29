import { describe, expect, it } from 'vitest'
import { MAX_PANES, autoLayout, isAutoLayout, layoutOrder } from '@shared/autoLayout'
import type { SplitNode } from '@shared/types'

/**
 * Раскладка — это правило, а не картинка: «две-три панели колонками, четыре —
 * сетка». Правило проверяется тестом, иначе его проверяют глазами на четырёх
 * открытых терминалах, и каждый раз заново.
 *
 * Отдельно проверяется то, что человек заметит сразу: порядок панелей. Панель
 * не должна прыгать на чужое место при появлении соседа — её ищут глазами там,
 * где оставили.
 */
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`)

describe('автораскладка', () => {
  it('одна панель — во весь экран, без делений', () => {
    expect(autoLayout(['s1'])).toEqual({ type: 'leaf', sessionId: 's1' })
  })

  it('пусто — раскладки нет', () => {
    expect(autoLayout([])).toBeNull()
  })

  it('две и три — колонки, а не квадраты', () => {
    // У CLI длинные строки и длинные ходы: ему нужна высота, а не квадрат.
    const two = autoLayout(ids(2)) as Extract<SplitNode, { type: 'split' }>
    expect(two.dir).toBe('row')
    const three = autoLayout(ids(3)) as Extract<SplitNode, { type: 'split' }>
    expect(three.dir).toBe('row')
    // Никаких вертикальных делений на трёх панелях.
    const dirs: string[] = []
    const walk = (n: SplitNode): void => {
      if (n.type === 'leaf') return
      dirs.push(n.dir)
      walk(n.a)
      walk(n.b)
    }
    walk(three)
    expect(dirs).toEqual(['row', 'row'])
  })

  it('три колонки равные', () => {
    const three = autoLayout(ids(3)) as Extract<SplitNode, { type: 'split' }>
    expect(three.ratio).toBeCloseTo(1 / 3, 5)
    expect((three.b as Extract<SplitNode, { type: 'split' }>).ratio).toBeCloseTo(0.5, 5)
  })

  it('четыре — сетка 2×2: две строки по две панели', () => {
    const four = autoLayout(ids(4)) as Extract<SplitNode, { type: 'split' }>
    expect(four.dir).toBe('col')
    expect((four.a as Extract<SplitNode, { type: 'split' }>).dir).toBe('row')
    expect((four.b as Extract<SplitNode, { type: 'split' }>).dir).toBe('row')
  })

  it('сетка читается слева направо и сверху вниз', () => {
    // s1 s2
    // s3 s4 — иначе панели в сетке идут не в том порядке, в каком их открывали.
    const four = autoLayout(ids(4)) as Extract<SplitNode, { type: 'split' }>
    const top = four.a as Extract<SplitNode, { type: 'split' }>
    const bottom = four.b as Extract<SplitNode, { type: 'split' }>
    expect(top.a).toEqual({ type: 'leaf', sessionId: 's1' })
    expect(top.b).toEqual({ type: 'leaf', sessionId: 's2' })
    expect(bottom.a).toEqual({ type: 'leaf', sessionId: 's3' })
    expect(bottom.b).toEqual({ type: 'leaf', sessionId: 's4' })
  })

  it('порядок панелей сохраняется при любом числе', () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      expect(layoutOrder(autoLayout(ids(n)))).toEqual(ids(n))
    }
  })

  it('лишние панели за потолок не попадают в дерево', () => {
    // Пятая уходит новой вкладкой; молча ужимать сетку до пяти нельзя — на пяти
    // лента превращается в пять строк.
    expect(layoutOrder(autoLayout(ids(6)))).toEqual(ids(MAX_PANES))
  })

  it('уже правильная раскладка распознаётся и не трогается', () => {
    // Пересборка дерева заставляет панели переехать, а переезд — это лишний
    // повод потерять экран терминала. Правильное дерево трогать нечем.
    for (let n = 1; n <= MAX_PANES; n++) expect(isAutoLayout(autoLayout(ids(n)))).toBe(true)
  })

  it('раскладка, сделанная руками, распознаётся как чужая', () => {
    const manual: SplitNode = {
      type: 'split',
      dir: 'col',
      ratio: 0.7,
      a: { type: 'leaf', sessionId: 's1' },
      b: { type: 'leaf', sessionId: 's2' }
    }
    expect(isAutoLayout(manual)).toBe(false)
  })

  it('растянутая руками пропорция считается своей раскладкой', () => {
    const stretched = autoLayout(ids(2)) as Extract<SplitNode, { type: 'split' }>
    stretched.ratio = 0.72
    // Иначе после каждой протяжки разделителя раскладка «чинилась» бы обратно.
    expect(isAutoLayout(stretched)).toBe(false)
  })
})
