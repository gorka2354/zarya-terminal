import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label?: string
  hint?: string
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  onClick?: () => void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

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
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Меню съело клавишу: дальше её пускать нельзя — иначе Esc заодно прервёт
      // ход агента или уедет в шелл.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    // Фаза ЗАХВАТА, а не всплытия. xterm вешает свой keydown на textarea в
    // capture и для Escape зовёт preventDefault + stopPropagation — до window
    // событие в фазе всплытия не доходит вовсе, и меню, открытое при
    // сфокусированном терминале, по Esc не закрывалось.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [x, y, onClose])

  return createPortal(
    <div
      ref={ref}
      className="zy-context-menu"
      style={pos}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="zy-context-sep" />
        ) : (
          <button
            key={i}
            className={`zy-context-item${item.danger ? ' zy-context-item--danger' : ''}`}
            disabled={item.disabled}
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

/** Hook helper: state + open(x,y,items). */
export function useContextMenu(): {
  menu: React.JSX.Element | null
  open: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
} {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  return {
    menu: state ? (
      <ContextMenu x={state.x} y={state.y} items={state.items} onClose={() => setState(null)} />
    ) : null,
    open: (x, y, items) => setState({ x, y, items }),
    close: () => setState(null)
  }
}
