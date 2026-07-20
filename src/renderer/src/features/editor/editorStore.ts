import { create } from 'zustand'

/**
 * STUB — replaced by the editor feature implementation.
 * Contract consumed by App and the terminal core:
 *  - files/activeId reactivity for layout
 *  - openFile(path, line?) / openDiff(cwd, path) imperative API
 */
export interface OpenFile {
  id: string
  path: string
  name: string
  dirty: boolean
  kind: 'file' | 'diff'
}

interface EditorState {
  files: OpenFile[]
  activeId: string | null
  openFile: (path: string, line?: number) => void
  openDiff: (cwd: string, path: string) => void
  closeFile: (id: string) => void
  setActive: (id: string) => void
}

export const useEditorStore = create<EditorState>(() => ({
  files: [],
  activeId: null,
  openFile: () => {},
  openDiff: () => {},
  closeFile: () => {},
  setActive: () => {}
}))
