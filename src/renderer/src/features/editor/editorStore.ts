import { t } from '@/lib/i18n'
import { create } from 'zustand'
import type { FileContent, GitDiff } from '@shared/types'
import { emitBus } from '@/lib/bus'
import { uid } from '@/lib/uid'
import { useUiStore } from '@/state/uiStore'
import { registerEditorBridge } from './editorBridge'

/**
 * Editor feature store — open file/diff tabs plus their live buffer state.
 * Purely in-memory (nothing persisted here); the file tree and terminal
 * core reach it through openFileInEditor/openDiffInEditor (editorBridge).
 */
export interface OpenFile {
  id: string
  path: string
  name: string
  dirty: boolean
  kind: 'file' | 'diff'
  /** Current buffer content, kept in sync with the Monaco model. */
  content: string
  /** Content as last read from / written to disk. dirty = content !== savedContent. */
  savedContent: string
  /** HEAD content, only set for kind === 'diff'. */
  original?: string
  /** Repo root the diff was computed against. */
  cwd?: string
  /** True while the initial read/diff request is in flight. */
  loading: boolean
  /** True when fs.readFile reported binary content — never actually opened. */
  binary: boolean
  /** True for files too large to read fully — edits are blocked so a save can't truncate the rest of the file on disk. */
  readOnly: boolean
}

interface PendingReveal {
  fileId: string
  line: number
  /** Unique per request so re-clicking the same file/line still triggers a reveal. */
  token: string
}

interface EditorState {
  files: OpenFile[]
  activeId: string | null
  pendingReveal: PendingReveal | null

  openFile: (path: string, line?: number) => Promise<void>
  openDiff: (cwd: string, path: string) => Promise<void>
  closeFile: (id: string) => void
  setActive: (id: string) => void
  /** Called by EditorPane on every keystroke to mirror the Monaco model into the store. */
  setContent: (id: string, content: string) => void
  save: (id: string) => Promise<void>
  /**
   * Перечитать открытые вкладки после того, как файлы изменились НЕ через нас.
   *
   * Так бывает после отката кода: диск переписан, а вкладка про это не знает.
   * Дальше два исхода, и оба плохие — Ctrl+S затирает откат устаревшей копией,
   * либо человек закрывает вкладку и теряет свой текст. Поэтому чистые вкладки
   * молча обновляем, а грязные НЕ трогаем: несохранённый текст человека дороже
   * нашей аккуратности, и решать за него мы не вправе.
   *
   * Возвращает пути, которые остались расходиться, — о них надо сказать вслух.
   */
  reloadFromDisk: (paths: string[]) => Promise<string[]>
  clearPendingReveal: () => void
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// Ids are derived from the path (lower-cased — Windows paths are
// case-insensitive) so re-opening the same file/diff activates the
// existing tab instead of duplicating it.
function fileId(path: string): string {
  return `file:${path.toLowerCase()}`
}

function diffId(cwd: string, path: string): string {
  return `diff:${cwd.toLowerCase()}:${path.toLowerCase()}`
}

/** Removes a tab and picks the next sensible active tab (right neighbour, then left). */
function withoutFile(
  files: OpenFile[],
  activeId: string | null,
  id: string
): Pick<EditorState, 'files' | 'activeId'> {
  const idx = files.findIndex((f) => f.id === id)
  const next = files.filter((f) => f.id !== id)
  let active = activeId
  if (activeId === id) {
    active = next[idx]?.id ?? next[idx - 1]?.id ?? null
  }
  return { files: next, activeId: active }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  files: [],
  activeId: null,
  pendingReveal: null,

  openFile: async (path, line) => {
    const id = fileId(path)
    const existing = get().files.find((f) => f.id === id)
    if (existing) {
      set((s) => ({
        activeId: id,
        pendingReveal: line ? { fileId: id, line, token: uid('r') } : s.pendingReveal
      }))
      return
    }

    const name = basename(path)
    const placeholder: OpenFile = {
      id,
      path,
      name,
      dirty: false,
      kind: 'file',
      content: '',
      savedContent: '',
      loading: true,
      binary: false,
      readOnly: false
    }
    set((s) => ({ files: [...s.files, placeholder], activeId: id }))

    let res: FileContent
    try {
      res = await window.zarya.fs.readFile(path)
    } catch (e) {
      useUiStore.getState().toast(t('ed.openFail', { name, err: String(e) }), 'error')
      set((s) => withoutFile(s.files, s.activeId, id))
      return
    }

    if (res.binary) {
      useUiStore.getState().toast(t('ed.binary', { name }), 'error')
      set((s) => withoutFile(s.files, s.activeId, id))
      return
    }
    if (res.truncated) {
      useUiStore.getState().toast(t('ed.tooBig', { name }), 'info')
    }

    const loaded = res
    set((s) => ({
      files: s.files.map((f) =>
        f.id === id
          ? {
              ...f,
              content: loaded.content,
              savedContent: loaded.content,
              loading: false,
              readOnly: loaded.truncated
            }
          : f
      ),
      pendingReveal: line ? { fileId: id, line, token: uid('r') } : s.pendingReveal
    }))
  },

  openDiff: async (cwd, path) => {
    const id = diffId(cwd, path)
    const existing = get().files.find((f) => f.id === id)
    if (existing) {
      set({ activeId: id })
      return
    }

    const name = basename(path)
    const placeholder: OpenFile = {
      id,
      path,
      name,
      dirty: false,
      kind: 'diff',
      content: '',
      savedContent: '',
      original: '',
      cwd,
      loading: true,
      binary: false,
      readOnly: true
    }
    set((s) => ({ files: [...s.files, placeholder], activeId: id }))

    let res: GitDiff | null
    try {
      res = await window.zarya.git.diffFile(cwd, path)
    } catch (e) {
      useUiStore.getState().toast(t('ed.diffFail', { err: String(e) }), 'error')
      set((s) => withoutFile(s.files, s.activeId, id))
      return
    }
    if (!res) {
      useUiStore.getState().toast(t('ed.diffFailName', { name }), 'error')
      set((s) => withoutFile(s.files, s.activeId, id))
      return
    }

    const diff = res
    /*
     * Файл не поместился в потолок чтения — сказать об этом обязаны здесь.
     *
     * Вкладка покажет начало и на этом остановится. Без предупреждения человек
     * прочитает её как «вот и вся правка» и решит по неполной картине.
     */
    if (diff.tooBig) useUiStore.getState().toast(t('ed.diffTooBig', { name }), 'info')
    set((s) => ({
      files: s.files.map((f) =>
        f.id === id
          ? {
              ...f,
              content: diff.modified,
              savedContent: diff.modified,
              original: diff.original,
              loading: false
            }
          : f
      )
    }))
  },

  closeFile: (id) => {
    const f = get().files.find((x) => x.id === id)
    if (!f) return
    if (f.dirty && !window.confirm(t('ed.closeDirty', { name: f.name }))) return
    set((s) => withoutFile(s.files, s.activeId, id))
  },

  setActive: (id) => set({ activeId: id }),

  setContent: (id, content) =>
    set((s) => ({
      files: s.files.map((f) =>
        f.id === id ? { ...f, content, dirty: content !== f.savedContent } : f
      )
    })),

  save: async (id) => {
    const f = get().files.find((x) => x.id === id)
    if (!f || f.kind !== 'file' || !f.dirty) return
    try {
      await window.zarya.fs.writeFile(f.path, f.content)
      set((s) => ({
        files: s.files.map((x) =>
          x.id === id ? { ...x, savedContent: x.content, dirty: false } : x
        )
      }))
      emitBus('editor:file-saved', { path: f.path })
      useUiStore.getState().toast(t('ed.saved', { name: f.name }), 'success')
    } catch (e) {
      useUiStore.getState().toast(t('ed.saveFail', { name: f.name, err: String(e) }), 'error')
    }
  },

  reloadFromDisk: async (paths) => {
    const norm = (p: string): string => p.split('\\').join('/').toLowerCase()
    const wanted = new Set(paths.map(norm))
    const open = get().files.filter((f) => f.kind === 'file' && wanted.has(norm(f.path)))
    const untouched: string[] = []
    for (const f of open) {
      if (f.dirty) {
        // Несохранённый текст человека дороже нашей аккуратности: молча
        // перезаписать его буфер — значит потерять то, что он писал.
        untouched.push(f.path)
        continue
      }
      try {
        const res = await window.zarya.fs.readFile(f.path)
        if (res.binary) {
          // Двоичное содержимое во вкладку не подставить — но и промолчать
          // нельзя: на экране осталось то, чего на диске уже нет. Считаем такую
          // вкладку неперечитанной, чтобы человек об этом узнал.
          untouched.push(f.path)
          continue
        }
        set((s) => ({
          files: s.files.map((x) =>
            x.id === f.id ? { ...x, content: res.content, savedContent: res.content } : x
          )
        }))
      } catch {
        // Файла может уже не быть — откат умеет и удалять. Вкладку оставляем
        // человеку: закрыть её за него значит убрать с глаз то, что он видел.
        untouched.push(f.path)
      }
    }
    return untouched
  },

  clearPendingReveal: () => set({ pendingReveal: null })
}))

// Wire the terminal core -> editor bridge (e.g. clicking a path in a block's
// output) exactly once, as a module side effect.
registerEditorBridge(
  (path, line) => void useEditorStore.getState().openFile(path, line),
  (cwd, path) => void useEditorStore.getState().openDiff(cwd, path)
)
