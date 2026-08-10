import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import { scanFiles, type ScannedFile } from './fileScan'
import { openFileInEditor } from '@/features/editor/editorBridge'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import './palette.css'

/**
 * Quick-open (Ctrl+P): fuzzy file finder rooted at the active session's cwd.
 * Scans lazily on open (BFS, bounded depth/count) and caches for the
 * duration the overlay stays open.
 */
export default function QuickOpen(): React.JSX.Element | null {
  const open = useUiStore((s) => s.quickOpenOpen)
  const tabs = useSessionsStore((s) => s.tabs)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const sessions = useSessionsStore((s) => s.sessions)
  const activeSessionId = tabs.find((t) => t.id === activeTabId)?.activeSessionId ?? null
  const root = (activeSessionId && sessions[activeSessionId]?.cwd) || ''

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [files, setFiles] = useState<ScannedFile[]>([])
  const [scanning, setScanning] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const scanGen = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    setFiles([])
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const gen = ++scanGen.current
    if (root) {
      setScanning(true)
      void scanFiles(root).then((result) => {
        if (scanGen.current !== gen) return
        setFiles(result)
        setScanning(false)
      })
    }

    return () => {
      cancelAnimationFrame(id)
      document.body.style.overflow = prevOverflow
      scanGen.current++ // invalidate any in-flight scan, force rescan next open
    }
  }, [open, root])

  const filtered = useMemo(() => {
    if (!open) return []
    return fuzzyFilter(query, files, (f) => f.rel, 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, files, open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const commit = (file: ScannedFile | undefined): void => {
    if (!file) return
    useUiStore.getState().set({ quickOpenOpen: false })
    openFileInEditor(file.path)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      useUiStore.getState().set({ quickOpenOpen: false })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(filtered[selectedIndex])
    }
  }

  if (!open) return null

  return (
    <div
      className="zy-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useUiStore.getState().set({ quickOpenOpen: false })
      }}
    >
      <div className="zy-modal" role="dialog" aria-label={t('qo.aria')}>
        <div className="zy-palette-input-row">
          <span className="zy-palette-input-icon">⌕</span>
          <input
            ref={inputRef}
            className="zy-palette-input"
            placeholder={root ? t('qo.placeholder') : t('qo.noSession')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!root}
            role="combobox"
            aria-expanded
            aria-controls="zy-quickopen-listbox"
            aria-activedescendant={
              filtered[selectedIndex] ? `zy-quickopen-opt-${selectedIndex}` : undefined
            }
          />
          {scanning && <span className="zy-palette-scanning">{t('qo.scanning')}</span>}
        </div>
        <div className="zy-palette-list" role="listbox" id="zy-quickopen-listbox">
          {!root && <div className="zy-empty">{t('qo.noSessionLong')}</div>}
          {root && !scanning && !filtered.length && (
            <div className="zy-empty">{t('qo.noFiles')}</div>
          )}
          {filtered.map((file, index) => {
            const dir = file.rel.slice(0, file.rel.length - file.name.length).replace(/\/$/, '')
            return (
              <div
                key={file.path}
                id={`zy-quickopen-opt-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                className={`zy-palette-item${index === selectedIndex ? ' zy-palette-item--selected' : ''}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => commit(file)}
              >
                <span className="zy-palette-item-icon">⌷</span>
                <div className="zy-palette-item-body">
                  <div className="zy-palette-item-title zy-palette-item-title--mono">
                    {file.name}
                  </div>
                  {dir && <div className="zy-palette-item-sub">{dir}</div>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="zy-palette-footer">
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">↑↓</span> {t('qo.nav')}
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">Enter</span> {t('qo.open')}
          </span>
          <span className="zy-palette-footer-hint">
            <span className="zy-kbd">Esc</span> {t('pal.close')}
          </span>
        </div>
      </div>
    </div>
  )
}
