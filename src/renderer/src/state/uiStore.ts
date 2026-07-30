import { create } from 'zustand'
import type { AgentCapabilities, AgentEngine, ClaudeModelInfo, ClaudeUsage } from '@shared/types'
import { uid } from '@/lib/uid'
import { useSessionsStore } from '@/state/sessionsStore'

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
  /** Страница «Что нового» (обновление). */
  updateOpen: boolean
  paletteOpen: boolean
  quickOpenOpen: boolean
  aiBarOpen: boolean
  launchPadOpen: boolean
  /**
   * Сырой режим — по ПАНЕЛИ, а не по окну (inc-17).
   *
   * Признак «в терминале живёт полноэкранная программа» был один на окно, и
   * любая панель, запустив vim или htop, гасила ленты и строки ввода у всех
   * остальных, где в этот момент отвечали агенты. Теперь у каждой сессии свой.
   * Ключ — sessionId; отсутствие записи значит «блочный режим».
   */
  rawBySession: Record<string, boolean>
  /**
   * What the bottom bar's Enter targets: 'shell' — run as a terminal command
   * (Warp default); 'zarya' — Zarya's built-in agent; a native agent engine
   * ('claude-code' | 'codex' | 'gemini') — that driver. The chip switches it.
   */
  barMode: 'shell' | 'zarya' | AgentEngine
  /**
   * То же для режима строки: он ещё и переключается САМ, когда где-то начинается
   * ответ агента. На одну панель это удобно, на четыре — способ отправить
   * русский текст в оболочку как команду. `barMode` остаётся умолчанием для
   * новых панелей, а работает значение отсюда.
   */
  barModeBySession: Record<string, 'shell' | 'zarya' | AgentEngine>
  /** Capabilities per native engine (from the driver registry) — drives conditional UI. */
  agentCaps: Partial<Record<AgentEngine, AgentCapabilities>>
  /** Live Claude Code account status for the fuel gauge (model, effort, limits). */
  claudeStatus: { model?: string; effort?: string; usage?: ClaudeUsage }
  /** Context-window fill of the active engine's last turn — UNIVERSAL (Claude,
   *  Codex, ACP all report it), unlike the Claude-only subscription fuel. */
  agentContext: { pct?: number; tokens?: number; window?: number; engine?: AgentEngine }
  /** Dynamic model catalog from the SDK (future-proof — no hardcoded list). */
  claudeModels: ClaudeModelInfo[]
  /** Ultracode session mode (xhigh + workflow orchestration). Session-scoped, default off. */
  ultracode: boolean
  historyOverlayOpen: boolean
  /**
   * Развёрнутые панели — ПО ВКЛАДКАМ: ключ вкладки → её панель во весь экран.
   *
   * Сперва это было одно значение на окно, и оно врало соседним вкладкам:
   * развернул панель в первой вкладке, перешёл во вторую — там пропадали
   * разделители, а сайдбар писал «сейчас не видно» про панели, которые видно.
   * Разворот принадлежит вкладке, поэтому и хранится по вкладке: расхождение
   * становится невыразимым.
   *
   * Соседи развёрнутой панели остаются СМОНТИРОВАННЫМИ и просто не видны —
   * размонтировать значило бы пересоздать их терминалы и вернуть человека к
   * пустым экранам. В воркспейс это не сохраняется: разворот временный.
   */
  maximizedByTab: Record<string, string>
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
  updateOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  aiBarOpen: false,
  launchPadOpen: false,
  rawBySession: {},
  barMode: 'shell',
  barModeBySession: {},
  agentCaps: {},
  claudeStatus: {},
  agentContext: {},
  claudeModels: [],
  ultracode: false,
  historyOverlayOpen: false,
  maximizedByTab: {},
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
/**
 * Сырой режим конкретной панели. Читать только так: «сырой ли режим» без
 * указания панели — вопрос без ответа, когда панелей несколько.
 */
export function isRaw(state: UiState, sessionId: string | null | undefined): boolean {
  return !!sessionId && !!state.rawBySession[sessionId]
}
export function setRaw(sessionId: string | null | undefined, on: boolean): void {
  if (!sessionId) return
  const cur = useUiStore.getState().rawBySession
  if (!!cur[sessionId] === on) return
  const next = { ...cur }
  if (on) next[sessionId] = true
  else delete next[sessionId]
  useUiStore.getState().set({ rawBySession: next })
}
/** Режим строки этой панели; пока не выбран — общее умолчание. */
export function barModeOf(
  state: UiState,
  sessionId: string | null | undefined
): UiState['barMode'] {
  return (sessionId && state.barModeBySession[sessionId]) || state.barMode
}
export function setBarModeOf(sessionId: string | null | undefined, mode: UiState['barMode']): void {
  const st = useUiStore.getState()
  if (!sessionId) {
    st.set({ barMode: mode })
    return
  }
  if (st.barModeBySession[sessionId] === mode) return
  // Общее значение тоже двигаем: это умолчание для следующей новой панели.
  st.set({ barMode: mode, barModeBySession: { ...st.barModeBySession, [sessionId]: mode } })
}
/** Развёрнутая панель ЭТОЙ вкладки, если она есть. */
export function maximizedIn(state: UiState, tabId: string | null | undefined): string | null {
  return (tabId && state.maximizedByTab[tabId]) || null
}
/**
 * Развернуть панель вкладки / вернуть сетку (`null`).
 *
 * Одно место на все входы: строка сайдбара, шапка панели, контекстное меню.
 * Инвариант «развёрнута ровно та панель, что в фокусе» держится в
 * sessionsStore.setActiveSession — здесь только хранение.
 */
export function setMaximized(tabId: string, sessionId: string | null): void {
  const st = useUiStore.getState()
  const next = { ...st.maximizedByTab }
  if (sessionId) next[tabId] = sessionId
  else delete next[tabId]
  st.set({ maximizedByTab: next })
}
/** Вкладка закрылась — её разворот больше ничего не значит. */
export function forgetTabUi(tabId: string): void {
  const st = useUiStore.getState()
  if (!(tabId in st.maximizedByTab)) return
  const next = { ...st.maximizedByTab }
  delete next[tabId]
  st.set({ maximizedByTab: next })
}

/** Убрать записи закрытой сессии, чтобы карты не росли вечно. */
export function forgetSessionUi(sessionId: string): void {
  const st = useUiStore.getState()
  const raw = { ...st.rawBySession }
  const modes = { ...st.barModeBySession }
  delete raw[sessionId]
  delete modes[sessionId]
  st.set({ rawBySession: raw, barModeBySession: modes })
}

;(window as unknown as { __zaryaSetUi?: (p: Record<string, unknown>) => void }).__zaryaSetUi = (
  p
) => {
  // Прогоны писали { rawTerminal: true } — держим совместимость, адресуя
  // активной панели.
  if ('rawTerminal' in p) {
    const sid = useSessionsStore.getState().activeSessionId()
    setRaw(sid, !!p.rawTerminal)
    delete p.rawTerminal
  }
  useUiStore.getState().set(p as Partial<UiState>)
}
// Прогонам нужно адресовать КОНКРЕТНУЮ панель: «сырой ли режим» без указания
// панели — вопрос без ответа, когда панелей несколько.
;(
  window as unknown as { __zaryaSetRawFor?: (sessionId: string, on: boolean) => void }
).__zaryaSetRawFor = (sessionId, on) => setRaw(sessionId, on)
;(window as unknown as { __zaryaRawMap?: () => Record<string, boolean> }).__zaryaRawMap = () =>
  useUiStore.getState().rawBySession
;(window as unknown as { __zaryaBarModeFor?: (sessionId: string) => string }).__zaryaBarModeFor = (
  sessionId
) => barModeOf(useUiStore.getState(), sessionId)
;(window as unknown as { __zaryaAgentCaps?: () => unknown }).__zaryaAgentCaps = () =>
  useUiStore.getState().agentCaps
;(window as unknown as { __zaryaBarMode?: () => string }).__zaryaBarMode = () =>
  useUiStore.getState().barMode
;(window as unknown as { __zaryaClaudeStatus?: () => unknown }).__zaryaClaudeStatus = () =>
  useUiStore.getState().claudeStatus
;(window as unknown as { __zaryaClaudeModels?: () => unknown }).__zaryaClaudeModels = () =>
  useUiStore.getState().claudeModels
