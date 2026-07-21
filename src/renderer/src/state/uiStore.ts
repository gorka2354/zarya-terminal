import { create } from 'zustand'
import { uid } from '@/lib/uid'

export type SidebarView = 'sessions' | 'files' | 'workflows' | 'history' | null

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
}

interface UiState {
  sidebarView: SidebarView
  aiPanelOpen: boolean
  settingsOpen: boolean
  paletteOpen: boolean
  quickOpenOpen: boolean
  aiBarOpen: boolean
  launchPadOpen: boolean
  historyOverlayOpen: boolean
  /** Session id whose find-in-terminal bar is open. */
  searchOpenFor: string | null
  blocksPanelOpen: boolean
  maximized: boolean
  toasts: Toast[]

  setSidebar: (v: SidebarView) => void
  toggleSidebar: (v: Exclude<SidebarView, null>) => void
  set: (patch: Partial<UiState>) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: string) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarView: 'sessions',
  aiPanelOpen: false,
  settingsOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  aiBarOpen: false,
  launchPadOpen: false,
  historyOverlayOpen: false,
  searchOpenFor: null,
  blocksPanelOpen: false,
  maximized: false,
  toasts: [],

  setSidebar: (v) => set({ sidebarView: v }),
  toggleSidebar: (v) => set({ sidebarView: get().sidebarView === v ? null : v }),
  set: (patch) => set(patch),

  toast: (text, kind = 'info') => {
    const t: Toast = { id: uid('t'), kind, text }
    set({ toasts: [...get().toasts, t] })
    setTimeout(() => get().dismissToast(t.id), kind === 'error' ? 6000 : 3500)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

// QA hook: lets the offscreen capture harness drive UI overlays (launch pad,
// settings, palette) without native clicks. Harmless in production.
;(window as unknown as { __zaryaSetUi?: (p: Partial<UiState>) => void }).__zaryaSetUi = (p) =>
  useUiStore.getState().set(p)
