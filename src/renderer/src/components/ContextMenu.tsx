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
        left: Math.min(x, window.innerWidth - r.width - 8),
        top: Math.min(y, window.innerHeight - r.height - 8)
      })
    }
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
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
            <span>{item.label}</span>
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
