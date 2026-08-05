import { create } from 'zustand'
import type { AgentCapabilities, AgentEngine, ClaudeModelInfo, ClaudeUsage } from '@shared/types'
import { uid } from '@/lib/uid'
import { listLeaves } from '@shared/paneTree'
import { useSessionsStore } from '@/state/sessionsStore'

export type SidebarView = 'sessions' | 'files' | 'workflows' | 'history' | null

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
}

interface UiState {
  sidebarView: SidebarView
  /**
   * Куда вернуться, когда сайдбар разворачивают обратно.
   *
   * `Ctrl+B` раньше всегда открывал «Сессии»: человек, работавший с файлами,
   * после сворачивания оказывался в другом разделе и искал своё место заново.
   */
  lastSidebarView: Exclude<SidebarView, null>
  aiPanelOpen: boolean
  settingsOpen: boolean
  /**
   * С какой вкладки открыть настройки.
   *
   * Палитра ведёт сразу в раздел («Инструменты», «Голос»), а не высаживает во
   * «Внешний вид», откуда человек ищет нужное сам. Сбрасывается при закрытии:
   * следующий обычный вход в настройки должен открыть то, что было в прошлый раз.
   */
  settingsTab?: string
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
   * Новая модель, о которой ещё не сказали. Живёт в UI, а не в настройках:
   * это разовое сообщение, а не состояние, которое надо переживать перезапуск.
   */
  modelNews: { provider: string; ids: string[]; names: string[] } | null
  /**
   * То же для режима строки: он ещё и переключается САМ, когда где-то начинается
   * ответ агента. На одну панель это удобно, на четыре — способ отправить
   * русский текст в оболочку как команду. `barMode` остаётся умолчанием для
   * новых панелей, а работает значение отсюда.
   */
  barModeBySession: Record<string, 'shell' | 'zarya' | AgentEngine>
  /** Capabilities per native engine (from the driver registry) — drives conditional UI. */
  agentCaps: Partial<Record<AgentEngine, AgentCapabilities>>
  /**
   * Состояние учётной записи Claude Code: топливо подписки.
   *
   * Топливо общее ПО СМЫСЛУ — лимит один на аккаунт, сколько бы панелей ни
   * работало. Модель и усилие раньше лежали здесь же и потому врали: панель,
   * работавшая на Opus, показывала Sonnet, если ход в соседней закончился
   * последним. Они переехали в {@link agentStatusBySession}; здесь остались
   * как «последнее известное» для поверхностей без своей панели.
   */
  claudeStatus: { model?: string; effort?: string; usage?: ClaudeUsage }
  /**
   * Модель и усилие КАЖДОЙ панели.
   *
   * Ключ — sessionId панели. Пусто значит «эта панель ещё не ходила к агенту»,
   * и показывать нечего: чужая модель на её месте — та самая ложь, ради которой
   * всё и разводится.
   */
  agentStatusBySession: Record<string, { model?: string; effort?: string }>
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
  /** Session id whose find bar is open. */
  searchOpenFor: string | null
  /**
   * Что ищут в ленте панели и на каком совпадении стоят.
   *
   * Поиск обязан искать по тому, что человек ВИДИТ. В блочном режиме на экране
   * лента, а xterm рендерится за экраном — прежняя строка поиска работала по
   * нему, то есть подсвечивала невидимое и выглядела сломанной. Здесь живёт
   * запрос для ленты; сырой режим по-прежнему ищет по терминалу.
   *
   * `step` — счётчик нажатий «дальше/назад»: лента сама решает, какое
   * совпадение считать текущим, а строка поиска только просит подвинуться.
   */
  feedQuery: string
  feedStep: number
  /** Сколько нашлось и какое сейчас — заполняет лента, показывает строка поиска. */
  feedHits: { count: number; index: number }
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
  lastSidebarView: 'sessions',
  aiPanelOpen: false,
  settingsOpen: false,
  updateOpen: false,
  paletteOpen: false,
  quickOpenOpen: false,
  aiBarOpen: false,
  launchPadOpen: false,
  rawBySession: {},
  barMode: 'shell',
  modelNews: null,
  barModeBySession: {},
  agentCaps: {},
  claudeStatus: {},
  agentStatusBySession: {},
  agentContext: {},
  claudeModels: [],
  ultracode: false,
  historyOverlayOpen: false,
  maximizedByTab: {},
  searchOpenFor: null,
  feedQuery: '',
  feedStep: 0,
  feedHits: { count: 0, index: 0 },
  blocksPanelOpen: false,
  maximized: false,
  toasts: [],

  // Оба сеттера идут через общий `set` ниже — там же живёт память о последнем
  // открытом разделе. Отдельная запись мимо него означала бы, что правило
  // работает не везде, а «в тех местах, где о нём вспомнили».
  setSidebar: (v) => get().set({ sidebarView: v }),
  toggleSidebar: (v) => get().set({ sidebarView: get().sidebarView === v ? null : v }),
  /*
   * Последний ОТКРЫТЫЙ раздел запоминается ЗДЕСЬ, а не в каждом сеттере.
   *
   * `Ctrl+B` прячет сайдбар и должен вернуть то, что было, а не всегда
   * «Сессии»: человек, работавший с файлами, после сворачивания оказывался в
   * другом разделе и искал своё место заново. Вид меняют из четырёх мест —
   * setSidebar, toggleSidebar, прямой set из ActivityBar и QA-хук, — и правило
   * в одном из них молча не сработало бы в остальных. Прогон это и поймал.
   */
  set: (patch) =>
    set(
      'sidebarView' in patch && patch.sidebarView
        ? { ...patch, lastSidebarView: patch.sidebarView }
        : patch
    ),

  toast: (text, kind = 'info') => {
    const t: Toast = { id: uid('t'), kind, text }
    set({ toasts: [...get().toasts, t] })
    setTimeout(() => get().dismissToast(t.id), kind === 'error' ? 6000 : 3500)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

/** Return the capabilities of the currently-selected agent engine, or null. */
export function activeAgentCaps(): AgentCapabilities | null {
  const st = useUiStore.getState()
  // Режим берём У АКТИВНОЙ ПАНЕЛИ, а не общий: у каждой панели свой движок, и
  // общее значение — лишь умолчание для новых. Пока здесь стоял `barMode`,
  // возможности считались по чужому движку: панель работала с Claude Code, а
  // палитра прятала его действия, потому что общее умолчание было «оболочка».
  const mode = barModeOf(st, useSessionsStore.getState().activeSessionId())
  return mode === 'shell' || mode === 'zarya' ? null : (st.agentCaps[mode] ?? null)
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
/**
 * Модель и усилие ЭТОЙ панели.
 *
 * Без sessionId ответа нет: «какая сейчас модель» при четырёх панелях — вопрос
 * без смысла. Пустой ответ честнее подстановки соседней: панель, которая ещё не
 * ходила к агенту, ничего о своей модели не знает.
 */
export function agentStatusOf(
  state: UiState,
  sessionId: string | null | undefined
): { model?: string; effort?: string } {
  // Пустой ответ — ОДИН И ТОТ ЖЕ объект, а не новый на каждый вызов. Селектор
  // zustand сравнивает ссылки: свежий `{}` каждый раз означает «значение
  // изменилось» всегда, и компонент перерисовывается без остановки. Первая
  // версия так и делала — приложение переставало рисовать панели вовсе, и это
  // поймали сразу пять прогонов.
  return (sessionId && state.agentStatusBySession[sessionId]) || NO_STATUS
}
const NO_STATUS: { model?: string; effort?: string } = {}

/** Запомнить, на чём работает панель. Пустой патч ничего не меняет. */
export function setAgentStatusFor(
  sessionId: string | null | undefined,
  patch: { model?: string; effort?: string }
): void {
  if (!sessionId) return
  const st = useUiStore.getState()
  const cur = st.agentStatusBySession[sessionId] ?? {}
  const next = { ...cur, ...patch }
  if (cur.model === next.model && cur.effort === next.effort) return
  st.set({ agentStatusBySession: { ...st.agentStatusBySession, [sessionId]: next } })
}

/** Режим строки этой панели; пока не выбран — общее умолчание. */
export function barModeOf(
  state: UiState,
  sessionId: string | null | undefined
): UiState['barMode'] {
  return (sessionId && state.barModeBySession[sessionId]) || state.barMode
}
/**
 * Режим ТОЛЬКО этой панели, не трогая общее умолчание.
 *
 * Нужен авто-переключению: оно происходит само, когда где-то начинается ответ
 * агента, и объявлять чужой ход выбором человека нельзя — иначе следующая новая
 * панель откроется в режиме агента, которого никто не просил.
 */
export function setPaneBarMode(sessionId: string, mode: UiState['barMode']): void {
  const st = useUiStore.getState()
  if (st.barModeBySession[sessionId] === mode) return
  st.set({ barModeBySession: { ...st.barModeBySession, [sessionId]: mode } })
}
export function setBarModeOf(sessionId: string | null | undefined, mode: UiState['barMode']): void {
  const st = useUiStore.getState()
  if (!sessionId) {
    st.set({ barMode: mode })
    return
  }
  // Сверяем ОБА значения: у панели режим мог уже стоять (авто-переключением), а
  // общее умолчание — нет. Ранний выход по одной панели оставлял бы умолчание
  // расходиться с явным выбором человека.
  if (st.barModeBySession[sessionId] === mode && st.barMode === mode) return
  // Общее значение тоже двигаем: это умолчание для следующей новой панели.
  st.set({ barMode: mode, barModeBySession: { ...st.barModeBySession, [sessionId]: mode } })
}
/**
 * Развёрнутая панель ЭТОЙ вкладки, если она есть.
 *
 * Запись считается действительной, только пока названная панель ЖИВЁТ в этой
 * вкладке. Иначе висячая запись (панель уехала переездом) заставляла сайдбар
 * писать «сейчас не видно» про все панели вкладки, а обычный клик по панели
 * превращался в «развернуть». Проверка на чтении, а не только на записи: правок
 * дерева много, и каждая новая иначе снова могла бы оставить призрак.
 */
export function maximizedIn(state: UiState, tabId: string | null | undefined): string | null {
  const sid = (tabId && state.maximizedByTab[tabId]) || null
  if (!sid) return null
  const tab = useSessionsStore.getState().tabs.find((t) => t.id === tabId)
  return tab && listLeaves(tab.layout).includes(sid) ? sid : null
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
  st.set({
    rawBySession: raw,
    barModeBySession: modes,
    // Строка поиска по терминалу — тоже след: сессия открывается заново под тем
    // же id (restoreSaved), и восстановленная панель показывала бы открытый
    // поиск, которого в этой жизни никто не открывал.
    searchOpenFor: st.searchOpenFor === sessionId ? null : st.searchOpenFor
  })
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
  // Режим строки — как чипом: активной панели И общим умолчанием. Прямая запись
  // в общее значение больше ничего не переключала бы: у каждой панели свой режим.
  if ('barMode' in p) {
    const sid = useSessionsStore.getState().activeSessionId()
    setBarModeOf(sid, p.barMode as UiState['barMode'])
    delete p.barMode
  }
  // Модель и усилие, на которых панель работает СЕЙЧАС, живут по сессиям — у
  // каждой панели свой агент. Прогоны же по старой памяти пишут общий
  // `claudeStatus`, и запись уходила в никуда: подсветка «эта модель бежит»
  // читает статус сессии. Зеркалим на активную панель — ровно то же, что при
  // запуске делает сам пусковой экран (общее поле остаётся: в нём ещё лежит
  // расход по счёту, а он и правда общий).
  if (p.claudeStatus && typeof p.claudeStatus === 'object') {
    const s = p.claudeStatus as { model?: string; effort?: string }
    if (s.model || s.effort) {
      const sid = useSessionsStore.getState().activeSessionId()
      setAgentStatusFor(sid, { model: s.model, effort: s.effort })
    }
  }
  useUiStore.getState().set(p as Partial<UiState>)
}
/**
 * Прочитать состояние интерфейса. Нужен прогонам, которые проверяют не то, что
 * нарисовано, а то, что решено: например, вернул ли `Ctrl+B` прежний раздел
 * сайдбара, а не «Сессии».
 */
;(window as unknown as { __zaryaUi?: () => UiState }).__zaryaUi = () => useUiStore.getState()
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

// Режим КОНКРЕТНОЙ панели — поставить и посмотреть карту целиком. Прогону это
// нужно, чтобы проверить, что выбор человека переживает перезапуск.
;(
  window as unknown as { __zaryaSetPaneBarMode?: (sid: string, mode: string) => void }
).__zaryaSetPaneBarMode = (sid, mode) => setPaneBarMode(sid, mode as UiState['barMode'])
;(window as unknown as { __zaryaDumpUi?: () => unknown }).__zaryaDumpUi = () => ({
  barMode: useUiStore.getState().barMode,
  barModeBySession: useUiStore.getState().barModeBySession
})
