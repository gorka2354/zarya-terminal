import { useRef } from 'react'
import type { GutterRect, Rect } from '@shared/paneTree'
import { paneRects } from '@shared/paneTree'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { TerminalPane } from './TerminalPane'

/**
 * Рабочая область: ВСЕ панели всех вкладок — плоским списком по sessionId.
 *
 * Раньше панели рисовались вложенными контейнерами по дереву раскладки, и место
 * панели в разметке зависело от её места в дереве. Стоило закрыть одну из
 * четырёх — соседняя переезжала на другой уровень дерева, React пересобирал её
 * поддерево, и терминал создавался заново: прокрутка и вывод агента исчезали.
 * Оболочка перерисовывала видимый экран, поэтому потеря выглядела как «ничего не
 * случилось» — и обнаружилась только прямой меткой, которой оболочка не
 * присылала (см. paneTree).
 *
 * Теперь дерево — это только КООРДИНАТЫ. Панель живёт в списке по своему
 * sessionId и переживает любую перестройку раскладки, переезд в другую вкладку и
 * разворот на весь экран.
 */
export function PanesHost(): React.JSX.Element {
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const maximizedByTab = useUiStore((s) => s.maximizedByTab)
  const containerRef = useRef<HTMLDivElement>(null)
  /**
   * Порядок панелей в РАЗМЕТКЕ — по первому появлению и навсегда. Перестановка
   * ключей заставила бы React двигать узлы xterm по документу; узлы это
   * переживают, но WebGL-контекст при переносе теряется, и панель молча
   * переключается на медленный отрисовщик. Раскладка задаётся координатами,
   * поэтому порядок в разметке можно держать неподвижным.
   */
  const slotOrder = useRef<string[]>([])

  interface Slot {
    sessionId: string
    tabId: string
    rect: Rect
    active: boolean
    visible: boolean
  }
  const slots = new Map<string, Slot>()
  const gutters: (GutterRect & { tabId: string })[] = []

  for (const tab of tabs) {
    const tabVisible = tab.id === activeTabId
    // Разворот — свойство ВКЛАДКИ. Общее на окно значение врало соседям: пока в
    // первой вкладке панель была развёрнута, во второй пропадали разделители.
    const { panes, gutters: gs } = paneRects(tab.layout, maximizedByTab[tab.id])
    for (const p of panes) {
      slots.set(p.sessionId, {
        sessionId: p.sessionId,
        tabId: tab.id,
        rect: p.rect,
        active: tab.activeSessionId === p.sessionId,
        // Панель развёрнутого соседа получает нулевой прямоугольник: её не видно,
        // но она смонтирована — иначе возврат из «во весь экран» показал бы
        // пустые экраны.
        visible: tabVisible && p.rect.width > 0 && p.rect.height > 0
      })
    }
    // Разделители — только у видимой вкладки. Условие про разворот здесь не
    // нужно: развёрнутой вкладке paneRects и так не отдаёт разделителей, а
    // «развёрнута панель в ДРУГОЙ вкладке» не должна отбирать их у этой.
    if (tabVisible) gutters.push(...gs.map((g) => ({ ...g, tabId: tab.id })))
  }

  // Новые панели дописываются в конец, закрытые выпадают. Порядок остальных не
  // меняется никогда.
  for (const sid of slots.keys()) if (!slotOrder.current.includes(sid)) slotOrder.current.push(sid)
  slotOrder.current = slotOrder.current.filter((sid) => slots.has(sid))

  const pct = (v: number): string => `${v * 100}%`

  return (
    <div className="zy-panes" ref={containerRef}>
      {slotOrder.current.map((sid) => {
        const slot = slots.get(sid)
        if (!slot) return null
        return (
          <div
            key={sid}
            className={`zy-pane-slot${slot.visible ? '' : ' zy-pane-slot--hidden'}`}
            style={{
              left: pct(slot.rect.left),
              top: pct(slot.rect.top),
              width: pct(slot.rect.width),
              height: pct(slot.rect.height)
            }}
          >
            <TerminalPane sessionId={sid} active={slot.active} visible={slot.visible} />
          </div>
        )
      })}
      {gutters.map((g) => (
        <Gutter key={`${g.tabId}:${g.path.join('-')}`} g={g} containerRef={containerRef} />
      ))}
    </div>
  )
}

function Gutter({
  g,
  containerRef
}: {
  g: GutterRect & { tabId: string }
  containerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const isRow = g.node.dir === 'row'
  const at = isRow ? g.branch.left + g.branch.width * g.at : g.branch.top + g.branch.height * g.at

  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const box = container.getBoundingClientRect()
    const gutter = e.currentTarget as HTMLElement
    gutter.classList.add('zy-split-gutter--dragging')
    const move = (ev: PointerEvent): void => {
      const frac = isRow
        ? (ev.clientX - (box.left + g.branch.left * box.width)) / (g.branch.width * box.width)
        : (ev.clientY - (box.top + g.branch.top * box.height)) / (g.branch.height * box.height)
      // Путь, а не ссылка на узел: после первой же правки дерево пересобрано
      // новыми объектами, и ссылка перестала бы совпадать (см. paneTree).
      useSessionsStore.getState().setSplitRatio(g.tabId, g.path, Math.min(0.85, Math.max(0.15, frac)))
    }
    const up = (): void => {
      gutter.classList.remove('zy-split-gutter--dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pct = (v: number): string => `${v * 100}%`
  return (
    <div
      className={`zy-gutter zy-gutter--${g.node.dir}`}
      style={
        isRow
          ? {
              left: `calc(${pct(at)} - 3px)`,
              top: pct(g.branch.top),
              height: pct(g.branch.height)
            }
          : {
              top: `calc(${pct(at)} - 3px)`,
              left: pct(g.branch.left),
              width: pct(g.branch.width)
            }
      }
      onPointerDown={startDrag}
    />
  )
}
