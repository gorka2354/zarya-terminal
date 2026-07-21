import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import { type AppAction, getAllActions, onActionsChanged, runAction } from '@/lib/actionRegistry'
import { Icon } from '@/components/Icon'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { formatChord } from './keybindings'
import './palette.css'

/**
 * Global command palette (Ctrl+Shift+P): fuzzy-search every registered
 * action, grouped by category, with keybinding hints on the right.
 */
export default function CommandPalette(): React.JSX.Element | null {
  const open = useUiStore((s) => s.paletteOpen)
  const keybindings = useSettingsStore((s) => s.settings.keybindings)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [, forceTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // re-render when the action registry itself changes (feature modules
  // register their actions asynchronously during boot).
  useEffect(() => onActionsChanged(() => forceTick((n) => n + 1)), [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(id)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!open) return []
    return fuzzyFilter(
      query,
      getAllActions(),
      (a) => `${a.title} ${a.category} ${a.keywords ?? ''}`,
      200
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open])

  const groups = useMemo(() => {
    const map = new Map<string, AppAction[]>()
    for (const action of filtered) {
      let bucket = map.get(action.category)
      if (!bucket) {
        bucket = []
        map.set(action.category, bucket)
      }
      bucket.push(action)
    }
    return [...map.entries()]
  }, [filtered])

  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const commit = (action: AppAction | undefined): void => {
    if (!action) return
    useUiStore.getState().set({ paletteOpen: false })
    runAction(action.id)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      useUiStore.getState().set({ paletteOpen: false })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (flat.length ? (i + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(flat[selectedIndex])
    }
  }

  if (!open) return null

  return (
    <div
      className="zy-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useUiStore.getState().set({ paletteOpen: false })
      }}
    >
      <div className="zy-modal" role="dialog" aria-label="Палитра команд">
        <div className="zy-palette-input-row">
          <span className="zy-palette-input-icon zy-palette-input-icon--accent">
            <Icon name="search" size={14} strokeWidth={1.8} />
          </span>
          <input
            ref={inputRef}
            className="zy-palette-input"
            placeholder="Введите команду…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls="zy-palette-listbox"
            aria-activedescendant={flat[selectedIndex] ? `zy-palette-opt-${flat[selectedIndex].id}` : undefined}
          />
          <span className="zy-palette-title">Палитра</span>
        </div>
        <div className="zy-palette-list" role="listbox" id="zy-palette-listbox">
          {!flat.length && <div className="zy-empty">Ничего не найдено</div>}
          {groups.map(([category, items]) => (
            <div key={category}>
              <div className="zy-palette-group-label">{category}</div>
              {items.map((action) => {
                const index = flat.indexOf(action)
                const chord = keybindings[action.id]
                return (
                  <div
                    key={action.id}
                    id={`zy-palette-opt-${action.id}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={`zy-palette-item${index === selectedIndex ? ' zy-palette-item--selected' : ''}`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => commit(action)}
                  >
                    <span className="zy-palette-item-icon">
                      <span className="zy-palette-item-diamond" />
                    </span>
                    <div className="zy-palette-item-body">
                      <div className="zy-palette-item-title">{action.title}</div>
                    </div>
                    {chord && (
                      <span className="zy-palette-item-chord zy-kbd">{formatChord(chord)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="zy-palette-footer">
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">↑↓</span> выбор
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">↵</span> запуск
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">esc</span> закрыть
          </span>
        </div>
      </div>
    </div>
  )
}
