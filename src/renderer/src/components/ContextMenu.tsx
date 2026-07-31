import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label?: string
  hint?: string
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  onClick?: () => void
  /**
   * Пункт можно утащить мышью: (тип, данные) уедут в dataTransfer.
   *
   * Нужен проектам в шапке. Пока проекты жили в сайдбаре, их таскали прямо
   * оттуда на нужную панель; после переезда в меню перетаскивание пропало, и
   * «положить проект В ЭТУ панель» стало невозможно — оставалось «панелью рядом»
   * от активной. Меню при начале перетаскивания закрывается: тащат на панель,
   * а она под меню.
   */
  drag?: { type: string; data: string }
  /**
   * Дополнительные действия справа в строке.
   *
   * Появились из-за проектов: подменю наше меню не умеет, и «открыть панелью
   * рядом» жило ОТДЕЛЬНОЙ строкой под каждым проектом. Список из двух проектов
   * занимал четыре строки, а стрелка-отступ схлопывалась в мусор вида «Ⴑ,» —
   * понять, что к чему относится, было нельзя.
   */
  actions?: { title: string; node: React.ReactNode; danger?: boolean; onClick: () => void }[]
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /**
   * Элемент, по нажатию на который меню открылось.
   *
   * Нажатие по нему НЕ считается «щелчком снаружи»: меню закрывается по
   * mousedown, а кнопка переключается по click, и без этой оговорки второе
   * нажатие на ту же кнопку давало мигание — mousedown закрывал, следующий за
   * ним click открывал заново, и меню выглядело незакрываемым. Переключение
   * оставлено обработчику самой кнопки, он единственный знает, что значит
   * «нажали ещё раз».
   */
  anchor?: HTMLElement | null
}

export function ContextMenu({ x, y, items, onClose, anchor }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  /**
   * Пункт тащат прямо сейчас. Меню при этом ПРЯЧЕТСЯ, но остаётся в разметке:
   * убрать узел, который в этот момент тащат, — верный способ отменить
   * перетаскивание в середине жеста. Закроется оно по dragend.
   */
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({
        left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
        // Math.max(8, …) обязателен: у списка из двух десятков сессий высота
        // больше окна, `innerHeight - height - 8` уходит в минус, и меню
        // выезжает за ВЕРХНЮЮ кромку — первые пункты просто не увидеть. Высоту
        // ограничивает CSS (max-height + прокрутка), здесь остаётся не пустить
        // меню за край.
        top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
      })
    }
    const close = (e?: MouseEvent): void => {
      // Нажатие по кнопке-открывашке — не «снаружи»: она сама переключит меню.
      if (e && anchor && anchor.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Меню съело клавишу: дальше её пускать нельзя — иначе Esc заодно прервёт
      // ход агента или уедет в шелл.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Уход фокуса из окна закрывает меню всегда — якорь тут ни при чём.
    const onBlur = (): void => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', onBlur)
    // Фаза ЗАХВАТА, а не всплытия. xterm вешает свой keydown на textarea в
    // capture и для Escape зовёт preventDefault + stopPropagation — до window
    // событие в фазе всплытия не доходит вовсе, и меню, открытое при
    // сфокусированном терминале, по Esc не закрывалось.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [x, y, onClose, anchor])

  return createPortal(
    <div
      ref={ref}
      className={`zy-context-menu${dragging ? ' zy-context-menu--dragging' : ''}`}
      style={pos}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="zy-context-sep" />
        ) : item.actions?.length ? (
          // Строка с действиями: кнопку в кнопку вложить нельзя, поэтому здесь
          // строка — контейнер, а нажимаемого в ней несколько.
          <div
            key={i}
            className="zy-context-item zy-context-item--acts"
            draggable={!!item.drag}
            onDragStart={(e) => {
              if (!item.drag) return
              e.dataTransfer.setData(item.drag.type, item.drag.data)
              e.dataTransfer.effectAllowed = 'copy'
              setDragging(true)
            }}
            onDragEnd={() => {
              if (!item.drag) return
              setDragging(false)
              onClose()
            }}
          >
            <button
              className="zy-context-main"
              disabled={item.disabled}
              title={item.label}
              onClick={() => {
                onClose()
                item.onClick?.()
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="zy-context-hint">{item.hint}</span>}
            </button>
            {item.actions.map((a, k) => (
              <button
                key={k}
                className={`zy-context-act${a.danger ? ' zy-context-act--del' : ''}`}
                title={a.title}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                  a.onClick()
                }}
              >
                {a.node}
              </button>
            ))}
          </div>
        ) : (
          <button
            key={i}
            className={`zy-context-item${item.danger ? ' zy-context-item--danger' : ''}`}
            disabled={item.disabled}
            draggable={!!item.drag}
            onDragStart={(e) => {
              if (!item.drag) return
              e.dataTransfer.setData(item.drag.type, item.drag.data)
              e.dataTransfer.effectAllowed = 'copy'
              // Меню исчезает с глаз, но не из разметки: целятся в панель ПОД
              // ним, а удалить узел, который тащат, значит оборвать жест.
              setDragging(true)
            }}
            onDragEnd={() => {
              if (!item.drag) return
              setDragging(false)
              onClose()
            }}
            onClick={() => {
              onClose()
              item.onClick?.()
            }}
          >
            {/* Полный текст в подсказке: пункт укладывается в одну строку с
                многоточием, и у длинного заголовка сессии обрезанный текст —
                единственное опознание. Без title его стало бы не прочитать
                вообще, тогда как до перехода на одну строку он переносился. */}
            <span title={item.label}>{item.label}</span>
            {item.hint && <span className="zy-context-hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/**
 * Hook helper: state + open(x, y, items, anchor).
 *
 * `anchor` — кнопка, из обработчика которой меню открыли (обычно
 * `e.currentTarget`). Передавать её стоит всегда, когда меню открывается по
 * ЛЕВОМУ клику: без неё повторное нажатие на ту же кнопку закроет меню по
 * mousedown и тут же откроет по click. Для меню по правому клику (contextmenu)
 * это не нужно — там нет парного click.
 */
export function useContextMenu(): {
  menu: React.JSX.Element | null
  open: (x: number, y: number, items: MenuItem[], anchor?: HTMLElement | null) => void
  close: () => void
} {
  const [state, setState] = useState<{
    x: number
    y: number
    items: MenuItem[]
    anchor?: HTMLElement | null
  } | null>(null)
  return {
    menu: state ? (
      <ContextMenu
        x={state.x}
        y={state.y}
        items={state.items}
        anchor={state.anchor}
        onClose={() => setState(null)}
      />
    ) : null,
    // Повторное нажатие по ТОЙ ЖЕ кнопке закрывает меню. Иначе кнопке пришлось
    // бы самой хранить состояние «открыто/закрыто», а она его не видит: меню
    // умеет закрыться само (щелчком мимо, Esc, уходом фокуса), и любой такой
    // флаг у кнопки немедленно разошёлся бы с правдой. Здесь же состояние одно.
    open: (x, y, items, anchor) =>
      setState((prev) => (prev && anchor && prev.anchor === anchor ? null : { x, y, items, anchor })),
    close: () => setState(null)
  }
}
