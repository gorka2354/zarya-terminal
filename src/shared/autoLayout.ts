import type { SplitNode } from './types'

/**
 * Автоматическая раскладка панелей по их числу.
 *
 * Договорённость с владельцем: одна панель — во весь экран, две-три —
 * колонками, четыре — сетка 2×2. Пятая уходит новой вкладкой (см. MAX_PANES):
 * потолок задан не вёрсткой, а тем, что на пяти панелях лента превращается в
 * пять строк, и упирается это молча.
 *
 * Колонки для двух-трёх выбраны не случайно: у CLI длинные строки и длинные
 * ходы, ему нужна высота, а не квадрат. Квадрат появляется только на четырёх,
 * когда колонка стала бы уже полосы текста.
 *
 * Функция чистая и живёт отдельно от стора: раскладка — это правило, и его
 * проверяют тестом, а не глазами на четырёх открытых терминалах.
 */

/** Больше этого числа панелей в одной вкладке не показываем. */
export const MAX_PANES = 4

const leaf = (sessionId: string): SplitNode => ({ type: 'leaf', sessionId })
const row = (a: SplitNode, b: SplitNode, ratio: number): SplitNode => ({
  type: 'split',
  dir: 'row',
  ratio,
  a,
  b
})
const col = (a: SplitNode, b: SplitNode, ratio: number): SplitNode => ({
  type: 'split',
  dir: 'col',
  ratio,
  a,
  b
})

/**
 * Дерево для этих сессий. Порядок сохраняется: панель не должна прыгать на
 * чужое место при появлении соседа — человек ищет её глазами там, где оставил.
 */
export function autoLayout(sessionIds: string[]): SplitNode | null {
  const ids = sessionIds.slice(0, MAX_PANES)
  if (!ids.length) return null
  if (ids.length === 1) return leaf(ids[0])
  if (ids.length === 2) return row(leaf(ids[0]), leaf(ids[1]), 0.5)
  if (ids.length === 3) {
    // Три равные колонки: левая треть, а справа половина остатка.
    return row(leaf(ids[0]), row(leaf(ids[1]), leaf(ids[2]), 0.5), 1 / 3)
  }
  // Четыре — сетка 2×2: две СТРОКИ по две панели. Именно так, а не двумя
  // колонками: при колонках обход дерева даёт s1, s3, s2, s4 — то есть порядок
  // панелей в дереве расходится с тем, как их читают глазами, и четвёртая
  // панель появляется не там, где её ждут. Строками оба порядка совпадают.
  return col(row(leaf(ids[0]), leaf(ids[1]), 0.5), row(leaf(ids[2]), leaf(ids[3]), 0.5), 0.5)
}

/** Листья дерева слева направо — порядок, в котором панели видит человек. */
export function layoutOrder(node: SplitNode | null): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.sessionId]
  return [...layoutOrder(node.a), ...layoutOrder(node.b)]
}

/**
 * Совпадает ли текущее дерево с автоматическим для тех же панелей.
 *
 * Нужно, чтобы не перестраивать раскладку зря: пересборка дерева заставляет
 * панели переехать, а переезд панели — это пересоздание её терминала с пустым
 * экраном, если ключи не постоянные. Раскладка, которая и так правильная, не
 * должна трогаться вовсе.
 */
export function isAutoLayout(node: SplitNode | null): boolean {
  if (!node) return true
  return JSON.stringify(node) === JSON.stringify(autoLayout(layoutOrder(node)))
}
