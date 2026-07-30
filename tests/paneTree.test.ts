import { describe, expect, it } from 'vitest'
import { autoLayout } from '@shared/autoLayout'
import { closePane, paneRects, setRatioAt } from '@shared/paneTree'
import type { SplitNode } from '@shared/types'

/**
 * Закрытие панели — главный риск inc-18: «было четыре, стало три». Здесь
 * проверяются оба обещания, которые человек заметит сразу.
 *
 * 1. Раскладка пересобирается САМА, только пока её не трогали руками. Тронутую
 *    трогать нельзя: «починить» её значит отменить чужое решение молча.
 * 2. Фокус уходит соседней панели, а не «никуда»: без адресата Enter и Esc
 *    некому отдать, а они одобряют запуск команды.
 */
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`)
const four = autoLayout(ids(4)) as SplitNode

describe('закрытие панели', () => {
  it('четыре в сетке → три колонками: раскладку не трогали руками', () => {
    const res = closePane(four, 's3')
    expect(res.rebuilt).toBe(true)
    expect(res.layout).toEqual(autoLayout(['s1', 's2', 's4']))
  })

  it('раскладку тянули руками — она остаётся как есть', () => {
    // Тронутая пропорция: дерево перестало совпадать с автоматическим, и это
    // и есть замок. Отдельного флага не нужно — флаг рассинхронизировался бы.
    const dragged = setRatioAt(four, [], 0.7)
    const res = closePane(dragged, 's3')
    expect(res.rebuilt).toBe(false)
    // Пропорция человека уцелела, панель просто исчезла.
    expect(res.layout).not.toEqual(autoLayout(['s1', 's2', 's4']))
    expect((res.layout as Extract<SplitNode, { type: 'split' }>).ratio).toBeCloseTo(0.7)
  })

  it('фокус уходит СЛЕДУЮЩЕЙ панели по списку', () => {
    expect(closePane(four, 's2').focus).toBe('s3')
  })

  it('закрыли последнюю в списке — фокус предыдущей, а не «никуда»', () => {
    expect(closePane(four, 's4').focus).toBe('s3')
  })

  it('единственная панель — вкладке больше нечего показывать', () => {
    const res = closePane({ type: 'leaf', sessionId: 's1' }, 's1')
    expect(res.layout).toBeNull()
    expect(res.focus).toBeNull()
  })

  it('чужую панель не закрываем и фокус не двигаем', () => {
    const res = closePane(four, 'нет-такой')
    expect(res.focus).toBeNull()
    expect(res.layout).toEqual(four)
  })

  it('три колонки → две: пересобирается снова', () => {
    const three = autoLayout(ids(3)) as SplitNode
    const res = closePane(three, 's1')
    expect(res.rebuilt).toBe(true)
    expect(res.layout).toEqual(autoLayout(['s2', 's3']))
  })
})

/**
 * Геометрия. Панели рисуются плоским списком по координатам, потому что место в
 * разметке не должно зависеть от места в дереве: иначе перестройка раскладки
 * пересоздаёт терминал и человек видит пустой экран (см. paneTree).
 */
describe('координаты панелей', () => {
  it('сетка 2×2 — четыре равные четверти на своих местах', () => {
    const { panes } = paneRects(four)
    expect(panes.map((p) => p.sessionId)).toEqual(ids(4))
    expect(panes.map((p) => [p.rect.left, p.rect.top, p.rect.width, p.rect.height])).toEqual([
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5]
    ])
  })

  it('три панели — три колонки во всю высоту', () => {
    const { panes } = paneRects(autoLayout(ids(3)) as SplitNode)
    expect(panes.every((p) => p.rect.top === 0 && p.rect.height === 1)).toBe(true)
    for (const p of panes) expect(p.rect.width).toBeCloseTo(1 / 3)
  })

  it('панели не накладываются и покрывают всё место', () => {
    const { panes } = paneRects(four)
    const area = panes.reduce((sum, p) => sum + p.rect.width * p.rect.height, 0)
    expect(area).toBeCloseTo(1)
  })

  it('разделителей на один меньше, чем панелей, и каждый адресуется путём', () => {
    const { gutters } = paneRects(four)
    expect(gutters.length).toBe(3)
    // Путь ведёт к тому самому узлу: правка по пути меняет именно его пропорцию.
    for (const g of gutters) {
      const patched = setRatioAt(four, g.path, 0.2)
      const again = paneRects(patched).gutters.find((x) => x.path.join() === g.path.join())
      expect(again?.at).toBeCloseTo(0.2)
    }
  })

  it('развёрнутая панель занимает всё, соседи остаются в списке — но без места', () => {
    const { panes, gutters } = paneRects(four, 's2')
    expect(panes.length).toBe(4)
    const big = panes.find((p) => p.sessionId === 's2')
    expect([big?.rect.left, big?.rect.top, big?.rect.width, big?.rect.height]).toEqual([0, 0, 1, 1])
    // Соседи не выброшены: выбросить значит размонтировать и пересоздать терминал.
    expect(panes.filter((p) => p.rect.width === 0).map((p) => p.sessionId)).toEqual([
      's1',
      's3',
      's4'
    ])
    // Тянуть нечего: разделителей в развёрнутом виде нет.
    expect(gutters).toEqual([])
  })

  it('развёрнута панель ЧУЖОЙ вкладки — на эту раскладку это не влияет', () => {
    expect(paneRects(four, 'панель-другой-вкладки')).toEqual(paneRects(four))
  })
})
