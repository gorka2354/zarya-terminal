import { create } from 'zustand'
import type { AgentCapabilities, AgentEngine, ClaudeModelInfo, ClaudeUsage } from '@shared/types'
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
  /** Raw interactive terminal (type directly, run vim/claude/ssh) vs the block feed. */
  rawTerminal: boolean
  /**
   * What the bottom bar's Enter targets: 'shell' — run as a terminal command
   * (Warp default); 'zarya' — Zarya's built-in agent; a native agent engine
   * ('claude-code' | 'codex' | 'gemini') — that driver. The chip switches it.
   */
  barMode: 'shell' | 'zarya' | AgentEngine
  /** Capabilities per native engine (from the driver registry) — drives conditional UI. */
  agentCaps: Partial<Record<AgentEngine, AgentCapabilities>>
  /** Live Claude Code account status for the fuel gauge (model, effort, limits). */
  claudeStatus: { model?: string; effort?: string; usage?: ClaudeUsage }
  /** Dynamic model catalog from the SDK (future-proof — no hardcoded list). */
  claudeModels: ClaudeModelInfo[]
  /** Ultracode session mode (xhigh + workflow orchestration). Session-scoped, default off. */
  ultracode: boolean
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
  rawTerminal: false,
  barMode: 'shell',
  agentCaps: {},
  claudeStatus: {},
  claudeModels: [],
  ultracode: false,
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

/** Return the capabilities of the currently-selected agent engine, or null. */
export function activeAgentCaps(): AgentCapabilities | null {
  const { barMode, agentCaps } = useUiStore.getState()
  return barMode === 'shell' || barMode === 'zarya' ? null : (agentCaps[barMode] ?? null)
}

// Fetch the driver registry's capabilities once on boot so the UI can gate
// controls (fuel gauge, effort, bypass, model picker) per engine's real caps.
void window.zarya.agent
  .capabilities()
  .then((caps) => useUiStore.getState().set({ agentCaps: caps }))
  .catch(() => {})

// QA hook: lets the offscreen capture harness drive UI overlays (launch pad,
// settings, palette) without native clicks. Harmless in production.
;(window as unknown as { __zaryaSetUi?: (p: Partial<UiState>) => void }).__zaryaSetUi = (p) =>
  useUiStore.getState().set(p)
;(window as unknown as { __zaryaAgentCaps?: () => unknown }).__zaryaAgentCaps = () =>
  useUiStore.getState().agentCaps
;(window as unknown as { __zaryaBarMode?: () => string }).__zaryaBarMode = () =>
  useUiStore.getState().barMode
;(window as unknown as { __zaryaClaudeStatus?: () => unknown }).__zaryaClaudeStatus = () =>
  useUiStore.getState().claudeStatus
;(window as unknown as { __zaryaClaudeModels?: () => unknown }).__zaryaClaudeModels = () =>
  useUiStore.getState().claudeModels
