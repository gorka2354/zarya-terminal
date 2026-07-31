import type { SplitDirection, SplitNode } from './types'
import { autoLayout, isAutoLayout } from './autoLayout'

/**
 * Дерево панелей: обход, правки и ГЕОМЕТРИЯ.
 *
 * Геометрия здесь не ради красоты. Пока панели рисовались вложенными
 * контейнерами, место панели в разметке зависело от её места в ДЕРЕВЕ: стоило
 * закрыть одну из четырёх — и соседняя переезжала на другой уровень, React
 * пересобирал её поддерево, а вместе с ним пересоздавался терминал. Экран
 * панели при этом обнулялся: оболочка перерисовывала видимую часть, и потеря
 * выглядела как «ничего не случилось», хотя прокрутка и вывод агента исчезали.
 *
 * Поэтому панели рисуются ПЛОСКИМ списком по sessionId, а дерево превращается в
 * прямоугольники. Раскладка меняется — меняются только координаты; ни одна
 * панель не переезжает по разметке и ни один терминал не пересоздаётся.
 *
 * Модуль чистый: правила закрытия и раскладки проверяются тестом, а не четырьмя
 * открытыми терминалами.
 */

/** Прямоугольник в ДОЛЯХ рабочей области (0..1), а не в пикселях. */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export type SplitBranchNode = Extract<SplitNode, { type: 'split' }>

export interface PaneRect {
  sessionId: string
  rect: Rect
}

export interface GutterRect {
  /** Узел, чью пропорцию тянет этот разделитель. */
  node: SplitBranchNode
  /**
   * Путь до узла от корня: 0 — ветка «a», 1 — ветка «b».
   *
   * Адресуем путём, а не ссылкой на объект. Ссылка живёт ровно до первого
   * изменения: после правки пропорции дерево пересобирается новыми объектами, и
   * обработчик перетаскивания, замкнувший старый узел, больше ни с чем не
   * совпадает — разделитель прыгал на один шаг и застывал.
   */
  path: number[]
  /** Прямоугольник ВЕТКИ — от него считается доля при перетаскивании. */
  branch: Rect
  /** Доля вдоль оси ветки, где стоит разделитель (она же ratio узла). */
  at: number
}

// ------------------------------------------------------------------- обход

export function listLeaves(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.sessionId]
  return [...listLeaves(node.a), ...listLeaves(node.b)]
}

export function replaceLeaf(node: SplitNode, sessionId: string, replacement: SplitNode): SplitNode {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? replacement : node
  }
  return {
    ...node,
    a: replaceLeaf(node.a, sessionId, replacement),
    b: replaceLeaf(node.b, sessionId, replacement)
  }
}

export function removeLeaf(node: SplitNode, sessionId: string): SplitNode | null {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? null : node
  }
  const a = removeLeaf(node.a, sessionId)
  const b = removeLeaf(node.b, sessionId)
  if (a && b) return { ...node, a, b }
  return a ?? b
}

export function mapLeaves(node: SplitNode, map: (id: string) => string): SplitNode {
  if (node.type === 'leaf') return { type: 'leaf', sessionId: map(node.sessionId) }
  return { ...node, a: mapLeaves(node.a, map), b: mapLeaves(node.b, map) }
}

/** С какой стороны от целевой панели встаёт принесённая. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom'

/** Порядок листьев с новым — до или после цели. По нему собирается автораскладка. */
export function orderWith(
  leaves: string[],
  targetId: string,
  newId: string,
  side: DropSide
): string[] {
  const rest = leaves.filter((id) => id !== newId)
  const i = rest.indexOf(targetId)
  if (i < 0) return [...rest, newId]
  const before = side === 'left' || side === 'top'
  return [...rest.slice(0, before ? i : i + 1), newId, ...rest.slice(before ? i : i + 1)]
}

/**
 * Поставить панель ВПЛОТНУЮ к целевой с указанной стороны.
 *
 * Целевая делится пополам: сторона решает и ось (слева/справа — колонки,
 * сверху/снизу — строки), и кто из двоих окажется первым. Раньше сторона не
 * спрашивалась вовсе — принесённая панель всегда вставала справа, и человек,
 * целившийся в левый край, получал её не там, куда показывал.
 */
export function insertBeside(
  node: SplitNode,
  targetId: string,
  newId: string,
  side: DropSide
): SplitNode {
  const dir: SplitDirection = side === 'left' || side === 'right' ? 'row' : 'col'
  const first = side === 'left' || side === 'top'
  const target: SplitNode = { type: 'leaf', sessionId: targetId }
  const fresh: SplitNode = { type: 'leaf', sessionId: newId }
  return replaceLeaf(node, targetId, {
    type: 'split',
    dir,
    ratio: 0.5,
    a: first ? fresh : target,
    b: first ? target : fresh
  })
}

/** Поставить пропорцию узлу по пути. Путь: 0 — ветка «a», 1 — ветка «b». */
export function setRatioAt(node: SplitNode, path: number[], ratio: number): SplitNode {
  if (node.type !== 'split') return node
  if (!path.length) return { ...node, ratio }
  const [step, ...rest] = path
  return step === 0
    ? { ...node, a: setRatioAt(node.a, rest, ratio) }
    : { ...node, b: setRatioAt(node.b, rest, ratio) }
}

// --------------------------------------------------------------- закрытие

export interface CloseResult {
  /** Новое дерево; null — панель была последней и вкладка закрывается. */
  layout: SplitNode | null
  /** Пересобрали автоматически (4 → колонки) или оставили как было. */
  rebuilt: boolean
  /** Кому передать фокус: следующая панель по списку, иначе предыдущая. */
  focus: string | null
}

/**
 * Закрыть панель.
 *
 * Два решения, и оба видно человеку:
 *
 * 1. Раскладку пересобираем ТОЛЬКО если её не трогали руками. Тронутая
 *    раскладка — это чужое решение: «починить» её автоматически значит отменить
 *    работу человека ровно в тот момент, когда он этого не просил. Признак
 *    здесь не флаг, а совпадение дерева с автоматическим (`isAutoLayout`):
 *    флаг рассинхронизировался бы с деревом, а совпадение — не может.
 * 2. Фокус уходит СОСЕДНЕЙ панели, а не «никуда». Без адресата Enter и Esc
 *    некому отдать, а они одобряют запуск команды.
 */
export function closePane(layout: SplitNode, sessionId: string): CloseResult {
  const order = listLeaves(layout)
  const i = order.indexOf(sessionId)
  const focus = i < 0 ? null : (order[i + 1] ?? order[i - 1] ?? null)
  const stripped = removeLeaf(layout, sessionId)
  if (!stripped) return { layout: null, rebuilt: false, focus: null }
  if (isAutoLayout(layout)) {
    const auto = autoLayout(listLeaves(stripped))
    if (auto) return { layout: auto, rebuilt: true, focus }
  }
  return { layout: stripped, rebuilt: false, focus }
}

// -------------------------------------------------------------- геометрия

/**
 * Дерево → прямоугольники панелей и разделителей.
 *
 * `maximized` — панель, развёрнутая на всю вкладку. Остальные не выбрасываются
 * из списка, а получают признак «сейчас не видно»: выброшенная панель — это
 * пересозданный терминал, то есть пустой экран после возврата.
 */
export function paneRects(
  layout: SplitNode,
  maximized?: string | null
): { panes: PaneRect[]; gutters: GutterRect[] } {
  const panes: PaneRect[] = []
  const gutters: GutterRect[] = []
  const full: Rect = { left: 0, top: 0, width: 1, height: 1 }

  const walk = (node: SplitNode, rect: Rect, path: number[]): void => {
    if (node.type === 'leaf') {
      panes.push({ sessionId: node.sessionId, rect })
      return
    }
    const r = Math.min(0.95, Math.max(0.05, node.ratio))
    if (node.dir === 'row') {
      const aW = rect.width * r
      walk(node.a, { ...rect, width: aW }, [...path, 0])
      walk(node.b, { ...rect, left: rect.left + aW, width: rect.width - aW }, [...path, 1])
    } else {
      const aH = rect.height * r
      walk(node.a, { ...rect, height: aH }, [...path, 0])
      walk(node.b, { ...rect, top: rect.top + aH, height: rect.height - aH }, [...path, 1])
    }
    gutters.push({ node, path, branch: rect, at: r })
  }

  if (maximized && listLeaves(layout).includes(maximized)) {
    // Развёрнутая панель занимает всё; соседи остаются в списке с нулевым
    // прямоугольником — их рисуют скрытыми, а не размонтируют.
    for (const sid of listLeaves(layout)) {
      panes.push({
        sessionId: sid,
        rect: sid === maximized ? full : { left: 0, top: 0, width: 0, height: 0 }
      })
    }
    return { panes, gutters }
  }

  walk(layout, full, [])
  return { panes, gutters }
}
