import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry, GitStatus } from '@shared/types'
import { type MenuItem, useContextMenu } from '@/components/ContextMenu'
import { shortenPath } from '@/lib/ansi'
import { onBus } from '@/lib/bus'
import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorStore } from './editorStore'
import './editor.css'

type GitCode = 'mod' | 'new' | 'del' | null

interface NodeState {
  expanded: boolean
  loading: boolean
  error: boolean
  children?: DirEntry[]
}

const EXT_DOT_COLOR: Record<string, string> = {
  ts: '#3b82c4',
  tsx: '#3b82c4',
  js: '#e8c547',
  jsx: '#e8c547',
  mjs: '#e8c547',
  cjs: '#e8c547',
  json: '#c9c95f',
  md: '#6ca8ff',
  mdx: '#6ca8ff',
  css: '#c792ea',
  scss: '#c792ea',
  less: '#c792ea',
  html: '#ff8a4c',
  png: '#3ddc97',
  jpg: '#3ddc97',
  jpeg: '#3ddc97',
  gif: '#3ddc97',
  svg: '#3ddc97',
  webp: '#3ddc97',
  ico: '#3ddc97'
}

function extDotColor(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return EXT_DOT_COLOR[name.slice(dot + 1).toLowerCase()] ?? null
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx > 0 ? trimmed.slice(0, idx) : trimmed
}

function classifyStatus(code: string): GitCode {
  if (!code || code.trim() === '') return null
  if (code.includes('?')) return 'new'
  if (code.includes('D')) return 'del'
  return 'mod'
}

/** repo-root-relative posix paths (from `git status`) -> absolute status code lookup. */
function buildGitMap(status: GitStatus | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!status) return map
  const root = status.root.replace(/\\/g, '/').replace(/\/+$/, '')
  for (const f of status.files) {
    const abs = `${root}/${f.path}`
    map.set(normPath(abs), f.status)
  }
  return map
}

export default function FileTree(): React.JSX.Element {
  const [followTerminal, setFollowTerminal] = useState(true)
  const [pinnedRoot, setPinnedRoot] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Record<string, NodeState>>({})
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const { menu, open } = useContextMenu()
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const followedCwd = useSessionsStore((s) => {
    const id = s.activeSessionId()
    return id ? s.sessions[id]?.cwd : undefined
  })

  const root = followTerminal ? followedCwd || null : pinnedRoot

  const loadChildren = useCallback(async (path: string, force = false): Promise<void> => {
    if (!force && nodesRef.current[path]?.children) return
    setNodes((p) => ({ ...p, [path]: { ...(p[path] ?? { expanded: true, error: false }), loading: true } }))
    try {
      const entries = await window.zarya.fs.readDir(path)
      setNodes((p) => ({
        ...p,
        [path]: { ...(p[path] ?? { expanded: true }), children: entries, loading: false, error: false }
      }))
    } catch {
      setNodes((p) => ({ ...p, [path]: { ...(p[path] ?? { expanded: true }), loading: false, error: true } }))
    }
  }, [])

  const refreshGit = useCallback(async (): Promise<void> => {
    if (!root) {
      setGitStatus(null)
      return
    }
    try {
      setGitStatus(await window.zarya.git.status(root))
    } catch {
      setGitStatus(null)
    }
  }, [root])

  const refresh = useCallback(async (): Promise<void> => {
    if (!root) return
    await refreshGit()
    const expanded = Object.entries(nodesRef.current)
      .filter(([, st]) => st.expanded)
      .map(([p]) => p)
    await Promise.all([root, ...expanded].map((p) => loadChildren(p, true)))
  }, [root, refreshGit, loadChildren])

  // (Re)load when the root changes.
  useEffect(() => {
    setNodes({})
    setGitStatus(null)
    if (root) {
      void loadChildren(root)
      void refreshGit()
    }
    // refreshGit already depends on root; loadChildren is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // Debounced auto-refresh whenever a command finishes anywhere.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = onBus('block:finished', () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 500)
    })
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [refresh])

  const gitMap = useMemo(() => buildGitMap(gitStatus), [gitStatus])
  const getGitCode = useCallback(
    (path: string): GitCode => {
      const code = gitMap.get(normPath(path))
      return code ? classifyStatus(code) : null
    },
    [gitMap]
  )

  const toggleExpand = useCallback(
    (path: string): void => {
      const expanded = !(nodesRef.current[path]?.expanded ?? false)
      setNodes((p) => ({ ...p, [path]: { ...(p[path] ?? { loading: false, error: false }), expanded } }))
      if (expanded) void loadChildren(path)
    },
    [loadChildren]
  )

  const pickRoot = async (): Promise<void> => {
    const dir = await window.zarya.app.pickDirectory()
    if (dir) setPinnedRoot(dir)
  }

  const createEntry = async (dirPath: string, isDir: boolean): Promise<void> => {
    const name = window.prompt(isDir ? 'Имя новой папки' : 'Имя нового файла')
    if (!name) return
    const path = joinPath(dirPath, name)
    try {
      await window.zarya.fs.create(path, isDir)
      await loadChildren(dirPath, true)
      if (!isDir) void useEditorStore.getState().openFile(path)
    } catch (e) {
      useUiStore.getState().toast(`Не удалось создать: ${String(e)}`, 'error')
    }
  }

  const renameEntry = async (entry: DirEntry): Promise<void> => {
    const name = window.prompt('Новое имя', entry.name)
    if (!name || name === entry.name) return
    const parent = parentOf(entry.path)
    try {
      await window.zarya.fs.rename(entry.path, joinPath(parent, name))
      await loadChildren(parent, true)
    } catch (e) {
      useUiStore.getState().toast(`Не удалось переименовать: ${String(e)}`, 'error')
    }
  }

  const deleteEntry = async (entry: DirEntry): Promise<void> => {
    if (!window.confirm(`Удалить «${entry.name}» в корзину?`)) return
    try {
      await window.zarya.fs.delete(entry.path)
      await loadChildren(parentOf(entry.path), true)
    } catch (e) {
      useUiStore.getState().toast(`Не удалось удалить: ${String(e)}`, 'error')
    }
  }

  const openEntryContext = (e: React.MouseEvent, entry: DirEntry, gitCode: GitCode): void => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = []
    if (!entry.isDir) {
      items.push({ label: 'Открыть', onClick: () => void useEditorStore.getState().openFile(entry.path) })
      if (gitCode && root) {
        items.push({
          label: 'Diff с HEAD',
          onClick: () => void useEditorStore.getState().openDiff(root, entry.path)
        })
      }
      items.push({ separator: true })
    }
    const targetDir = entry.isDir ? entry.path : parentOf(entry.path)
    items.push(
      { label: 'Новый файл…', onClick: () => void createEntry(targetDir, false) },
      { label: 'Новая папка…', onClick: () => void createEntry(targetDir, true) },
      { label: 'Переименовать…', onClick: () => void renameEntry(entry) },
      { separator: true },
      { label: 'Показать в проводнике', onClick: () => window.zarya.app.showItemInFolder(entry.path) },
      { label: 'Копировать путь', onClick: () => void navigator.clipboard.writeText(entry.path) },
      { separator: true },
      { label: 'Удалить', danger: true, onClick: () => void deleteEntry(entry) }
    )
    open(e.clientX, e.clientY, items)
  }

  const openRootContext = (e: React.MouseEvent): void => {
    if (e.target !== e.currentTarget || !root) return
    e.preventDefault()
    open(e.clientX, e.clientY, [
      { label: 'Новый файл…', onClick: () => void createEntry(root, false) },
      { label: 'Новая папка…', onClick: () => void createEntry(root, true) },
      { separator: true },
      { label: 'Показать в проводнике', onClick: () => window.zarya.app.showItemInFolder(root) },
      { label: 'Копировать путь', onClick: () => void navigator.clipboard.writeText(root) }
    ])
  }

  return (
    <>
      <div className="zy-sidebar-header">
        <span>Файлы</span>
        <div className="zy-row" style={{ gap: 2 }}>
          <button
            className={`zy-icon-btn${followTerminal ? ' zy-icon-btn--active' : ''}`}
            title="Следовать за активным терминалом"
            onClick={() => setFollowTerminal((v) => !v)}
          >
            📌
          </button>
          <button className="zy-icon-btn" title="Обновить" onClick={() => void refresh()} disabled={!root}>
            ↻
          </button>
        </div>
      </div>
      {!followTerminal && (
        <div className="zy-sidebar-search">
          <button className="zy-btn zy-btn--sm" style={{ width: '100%' }} onClick={() => void pickRoot()}>
            {pinnedRoot ? shortenPath(pinnedRoot, 30) : 'Выбрать папку…'}
          </button>
        </div>
      )}
      <div className="zy-sidebar-body" onContextMenu={openRootContext}>
        {!root && (
          <div className="zy-empty">
            {followTerminal
              ? 'Ждём, пока определится рабочая папка терминала…'
              : 'Выбери папку, чтобы открыть дерево файлов.'}
          </div>
        )}
        {root && (
          <>
            <div className="zy-tree-root-label" title={root}>
              {shortenPath(root, 40)}
            </div>
            <TreeChildren
              parentPath={root}
              depth={0}
              nodes={nodes}
              getGitCode={getGitCode}
              onToggle={toggleExpand}
              onOpenFile={(p) => void useEditorStore.getState().openFile(p)}
              onContextMenu={openEntryContext}
            />
          </>
        )}
      </div>
      {menu}
    </>
  )
}

interface TreeChildrenProps {
  parentPath: string
  depth: number
  nodes: Record<string, NodeState>
  getGitCode: (path: string) => GitCode
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: DirEntry, gitCode: GitCode) => void
}

function TreeChildren({ parentPath, depth, nodes, ...handlers }: TreeChildrenProps): React.JSX.Element | null {
  const state = nodes[parentPath]
  if (!state?.expanded && depth > 0) return null
  if (state?.loading && !state.children) return <div className="zy-tree-empty">Загрузка…</div>
  if (state?.error) return <div className="zy-tree-empty">Не удалось прочитать папку</div>
  if (!state?.children) return depth === 0 ? <div className="zy-tree-empty">Загрузка…</div> : null
  if (!state.children.length) return <div className="zy-tree-empty">Пусто</div>
  return (
    <>
      {state.children.map((entry) => (
        <TreeEntry key={entry.path} entry={entry} depth={depth} nodes={nodes} {...handlers} />
      ))}
    </>
  )
}

interface TreeEntryProps {
  entry: DirEntry
  depth: number
  nodes: Record<string, NodeState>
  getGitCode: (path: string) => GitCode
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: DirEntry, gitCode: GitCode) => void
}

function TreeEntry({ entry, depth, nodes, getGitCode, onToggle, onOpenFile, onContextMenu }: TreeEntryProps): React.JSX.Element {
  const state = nodes[entry.path]
  const expanded = !!state?.expanded
  const gitCode = getGitCode(entry.path)
  const dotColor = !entry.isDir ? extDotColor(entry.name) : null

  return (
    <>
      <div
        className="zy-tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={entry.path}
        onClick={() => (entry.isDir ? onToggle(entry.path) : onOpenFile(entry.path))}
        onContextMenu={(e) => onContextMenu(e, entry, gitCode)}
      >
        <span className="zy-tree-arrow">{entry.isDir ? (expanded ? '▾' : '▸') : ''}</span>
        <span className="zy-tree-icon">{entry.isDir ? '📁' : '📄'}</span>
        <span className="zy-tree-name">{entry.name}</span>
        {dotColor && <span className="zy-tree-ext-dot" style={{ background: dotColor }} />}
        {gitCode && <span className={`zy-tree-status-dot zy-tree-status-dot--${gitCode}`} title={gitCode} />}
      </div>
      {entry.isDir && expanded && (
        <TreeChildren
          parentPath={entry.path}
          depth={depth + 1}
          nodes={nodes}
          getGitCode={getGitCode}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      )}
    </>
  )
}
