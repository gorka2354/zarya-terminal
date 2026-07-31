import { t } from '@/lib/i18n'
import { create } from 'zustand'
import type {
  BlockRecord,
  SessionMeta,
  SessionSnapshot,
  SplitDirection,
  SplitNode,
  TabState,
  WorkspaceState
} from '@shared/types'
import { uid } from '@/lib/uid'
import { MAX_PANES, autoLayout, isAutoLayout } from '@shared/autoLayout'
import {
  closePane,
  insertBeside,
  listLeaves,
  mapLeaves,
  orderWith,
  removeLeaf,
  replaceLeaf,
  setRatioAt,
  type DropSide
} from '@shared/paneTree'
import { emitBus, onBus } from '@/lib/bus'
import { runQuitFlushers } from '@/lib/quitFlush'
import { useBlocksStore } from './blocksStore'
import { getSettings } from './settingsStore'
import { forgetPaneDraft } from './paneDrafts'
import { forgetSessionUi, forgetTabUi, maximizedIn, setMaximized, useUiStore } from './uiStore'
import { useAiStore } from '@/features/ai/aiStore'
import { forgetPaneHistory } from './paneHistory'
import { focusPane } from '@/terminal/paneFocus'
import {
  disposeTerminal,
  getTerminal,
  onPtyExit,
  peekPendingRestore,
  setPendingRestore,
  wirePtyEvents
} from '@/terminal/terminalRegistry'

export interface RuntimeSession {
  id: string
  title: string
  customTitle: boolean
  profileId: string
  shellName: string
  shellIcon: string
  cwd: string
  createdAt: number
  status: 'starting' | 'running' | 'exited'
  exitCode?: number
  pinned: boolean
  favorite: boolean
  restored: boolean
  nonce?: string
  integration: boolean
}

// ---------------------------------------------------------------- split tree

// Обход и правки дерева живут в @shared/paneTree — там же, где геометрия и
// правила закрытия: это чистые функции, и проверяются они тестом, а не четырьмя
// открытыми терминалами. Здесь только реэкспорт: `listLeaves` спрашивают из
// сайдбара и шапки.
export { listLeaves } from '@shared/paneTree'

/**
 * Поставить панель рядом с целевой — с оглядкой на то, чья раскладка.
 *
 * Пока раскладку не трогали руками, доли выбирает правило: три панели — равные
 * трети, четыре — сетка. Без этого перенос панели делил цель пополам, и три
 * панели вставали как 50/25/25 — человек видел перекос и не понимал, откуда он.
 * Вертикальную вставку правило не выражает, поэтому «сверху/снизу» всегда режет
 * цель: это уже ручная раскладка, и дальше её никто не пересобирает.
 */
function placeBeside(
  layout: SplitNode,
  targetId: string,
  newId: string,
  side: DropSide,
  /**
   * Была ли раскладка автоматической ДО правки. Спрашивается снаружи, потому что
   * при переезде внутри вкладки лист сначала вынимают: промежуточное дерево уже
   * не совпадает с автоматическим (три колонки минус одна — это не две равные),
   * и проверка по нему решала бы, что раскладку трогали руками. Итог был виден
   * глазами: панели вставали как 175/175/699 вместо равных третей.
   */
  wasAuto: boolean
): SplitNode {
  const horizontal = side === 'left' || side === 'right'
  if (horizontal && wasAuto) {
    const auto = autoLayout(orderWith(listLeaves(layout), targetId, newId, side))
    if (auto) return auto
  }
  return insertBeside(layout, targetId, newId, side)
}

// -------------------------------------------------------------------- store

interface SessionsState {
  sessions: Record<string, RuntimeSession>
  tabs: TabState[]
  activeTabId: string | null
  savedList: SessionMeta[]
  booted: boolean

  boot: () => Promise<void>
  newTab: (profileId?: string, cwd?: string) => Promise<string>
  closeTab: (tabId: string) => Promise<void>
  setActiveTab: (tabId: string) => void
  nextTab: (delta: 1 | -1) => void
  setActiveSession: (sessionId: string) => void
  /**
   * Разделить активную панель. `cwd` — папка НОВОЙ панели: без него панели
   * плодились в одном каталоге, то есть четыре панели давали четыре сеанса
   * одного проекта. Сценарий «в каждой панели свой проект» требовал открывать
   * папку вкладкой и терял смысл сетки.
   */
  splitActive: (dir: SplitDirection, cwd?: string) => Promise<void>
  /**
   * Новая панель ВПЛОТНУЮ к указанной, с той стороны, куда показали мышью.
   *
   * `splitActive` делит активную панель и всегда ставит новую следом; при
   * броске проекта человек указывает мышью КОНКРЕТНОЕ ребро, и вставать надо
   * туда, а не «где-нибудь рядом».
   */
  splitBeside: (targetSessionId: string, side: DropSide, cwd?: string) => Promise<void>
  /**
   * Перенести уже открытый терминал к другой панели. Процесс не трогаем совсем:
   * двигается только лист в дереве раскладки, а pty живёт в главном процессе и
   * про раскладку ничего не знает. Поэтому вкладка со сборкой или ssh переживает
   * переезд — перерисовывается лишь картинка.
   */
  movePaneNextTo: (sessionId: string, targetSessionId: string, side?: DropSide) => void
  /**
   * Вынести панель из сетки в СВОЙ рабочий стол.
   *
   * Обратный жест к перетаскиванию панели на панель. До него убрать лишний CLI
   * с разделённого экрана можно было только закрыв его — то есть убив живой
   * процесс. Здесь процесс не трогается вовсе: лист переезжает в новую вкладку,
   * панель исчезает с экрана и появляется в списке свёрнутой строкой.
   *
   * Активной остаётся ПРЕЖНЯЯ вкладка: человек убирал панель с глаз, а не
   * просил себя туда увести.
   */
  detachPane: (sessionId: string) => void
  /** Назвать рабочий стол. Пустое имя возвращает подпись «по панелям». */
  renameTab: (tabId: string, title: string) => void
  /** Пропорция узла раскладки. Узел адресуется ПУТЁМ от корня (см. paneTree). */
  setSplitRatio: (tabId: string, path: number[], ratio: number) => void
  closeSession: (sessionId: string, opts?: { save?: boolean }) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
  restoreSaved: (savedId: string) => Promise<void>
  refreshSavedList: () => Promise<void>
  toggleFlag: (savedId: string, flag: 'pinned' | 'favorite') => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSaved: (savedId: string) => Promise<void>
  updateCwd: (sessionId: string, cwd: string) => void
  snapshotSession: (sessionId: string) => Promise<void>
  snapshotAll: () => Promise<void>
  activeSessionId: () => string | null
}

let persistTimer: ReturnType<typeof setTimeout> | undefined
let autosaveTimer: ReturnType<typeof setInterval> | undefined
// In-flight lock for restoreSaved: prevents a double-click (or any rapid
// re-invocation) from racing between the `loadSnapshot` await and session
// creation, which would otherwise spawn two live sessions for one savedId
// and clobber the terminal handle.
const restoringIds = new Set<string>()

function schedulePersistWorkspace(get: () => SessionsState): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const { tabs, activeTabId } = get()
    void window.zarya.sessions.saveWorkspace({ tabs, activeTabId })
  }, 700)
}

async function spawnSession(
  set: (fn: (s: SessionsState) => Partial<SessionsState>) => void,
  session: RuntimeSession
): Promise<void> {
  const res = await window.zarya.pty.spawn({
    sessionId: session.id,
    profileId: session.profileId,
    cwd: session.cwd || undefined,
    cols: 100,
    rows: 30
  })
  set((s) => {
    const cur = s.sessions[session.id]
    if (!cur) return {}
    if (!res.ok) {
      useUiStore.getState().toast(t('sess.shellFail', { err: res.error ?? '?' }), 'error')
      return {
        sessions: {
          ...s.sessions,
          [session.id]: { ...cur, status: 'exited', exitCode: -1 }
        }
      }
    }
    return {
      sessions: {
        ...s.sessions,
        [session.id]: {
          ...cur,
          status: 'running',
          cwd: res.cwd ?? cur.cwd,
          shellName: res.profile?.name ?? cur.shellName,
          shellIcon: res.profile?.icon ?? cur.shellIcon,
          profileId: res.profile?.id ?? cur.profileId,
          nonce: res.nonce,
          integration: (res.profile?.integration ?? 'none') !== 'none'
        }
      }
    }
  })
}

/**
 * Старые снапшоты хранят автоматическую подпись «Терминал» как обычные данные:
 * до второго языка запасное имя было строкой, а не ключом. Пустое имя рисуется
 * по языку, поэтому такое имя считаем незаданным — иначе английский интерфейс
 * до конца жизни профиля показывал бы русское слово в списке панелей.
 */
const LEGACY_DEFAULT_TITLE = 'Терминал'

function restoredTitle(title: string): string {
  return title === LEGACY_DEFAULT_TITLE ? '' : title
}

function makeRuntime(partial: Partial<RuntimeSession> & { id: string }): RuntimeSession {
  const cwdBase = partial.cwd?.split(/[\\/]/).filter(Boolean).pop()
  return {
    title: cwdBase ?? '',
    customTitle: false,
    profileId: getSettings().terminal.defaultProfileId || 'auto',
    shellName: '',
    shellIcon: '>_',
    cwd: '',
    createdAt: Date.now(),
    status: 'starting',
    pinned: false,
    favorite: false,
    restored: false,
    integration: false,
    ...partial
  }
}

function buildMeta(session: RuntimeSession, blocks: BlockRecord[]): SessionMeta {
  const lastCmd = [...blocks].reverse().find((b) => b.command)?.command
  return {
    id: session.id,
    title: session.title,
    profileId: session.profileId,
    shellName: session.shellName,
    shellIcon: session.shellIcon,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    pinned: session.pinned,
    favorite: session.favorite,
    blocksCount: blocks.length,
    lastCommand: lastCmd
  }
}

const OUTPUT_SNAPSHOT_CAP = 20_000

function snapshotBlocks(sessionId: string): BlockRecord[] {
  const blocks = useBlocksStore.getState().bySession[sessionId] ?? []
  return blocks.map((b) => ({
    ...b,
    output: b.output.length > OUTPUT_SNAPSHOT_CAP ? b.output.slice(-OUTPUT_SNAPSHOT_CAP) : b.output
  }))
}

export const useSessionsStore = create<SessionsState>((set, get) => {
  const setPartial = (fn: (s: SessionsState) => Partial<SessionsState>): void => {
    set(fn as never)
  }

  return {
    sessions: {},
    tabs: [],
    activeTabId: null,
    savedList: [],
    booted: false,

    boot: async () => {
      wirePtyEvents()

      onPtyExit((sessionId, exitCode) => {
        setPartial((s) => {
          const cur = s.sessions[sessionId]
          if (!cur) return {}
          return {
            sessions: { ...s.sessions, [sessionId]: { ...cur, status: 'exited', exitCode } }
          }
        })
      })

      onBus('terminal:cwd-changed', ({ sessionId, cwd }) => {
        get().updateCwd(sessionId, cwd)
      })

      window.zarya.sessions.onPrepareQuit(() => {
        void (async () => {
          try {
            await get().snapshotAll()
            const { tabs, activeTabId } = get()
            await window.zarya.sessions.saveWorkspace({ tabs, activeTabId })
            // Flush AI conversations (registered via quitFlush) so the last
            // messages survive shutdown alongside the terminal snapshots.
            await runQuitFlushers()
          } finally {
            window.zarya.sessions.readyToQuit()
          }
        })()
      })

      await get().refreshSavedList()

      const settings = getSettings()
      let restoredAny = false
      if (settings.sessions.restoreOnLaunch === 'workspace') {
        const ws = await window.zarya.sessions.loadWorkspace()
        if (ws?.tabs.length) {
          restoredAny = await restoreWorkspace(ws, setPartial, get)
        }
      }
      if (!restoredAny && get().tabs.length === 0) {
        await get().newTab()
      }

      const autosaveSec = Math.max(5, settings.sessions.autosaveSec)
      clearInterval(autosaveTimer)
      autosaveTimer = setInterval(() => {
        void get().snapshotAll()
      }, autosaveSec * 1000)

      set({ booted: true })
    },

    newTab: async (profileId, cwd) => {
      const id = uid('s')
      const session = makeRuntime({
        id,
        profileId: profileId ?? getSettings().terminal.defaultProfileId ?? 'auto',
        cwd: cwd ?? ''
      })
      const tab: TabState = {
        id: uid('tab'),
        layout: { type: 'leaf', sessionId: id },
        activeSessionId: id
      }
      setPartial((s) => ({
        sessions: { ...s.sessions, [id]: session },
        tabs: [...s.tabs, tab],
        activeTabId: tab.id
      }))
      await spawnSession(setPartial, session)
      schedulePersistWorkspace(get)
      return id
    },

    closeTab: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      for (const sid of listLeaves(tab.layout)) {
        await get().closeSession(sid, { save: true })
      }
    },

    setActiveTab: (tabId) => {
      set({ activeTabId: tabId })
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab) {
        // Let the AI store follow the terminal (activeId → this terminal's chat).
        emitBus('terminal:focus', { sessionId: tab.activeSessionId })
        // Курсор — в строку ввода панели, а не в скрытое поле xterm. Фокус в
        // поле терминала делает голый Enter «чужим полем» для гейта: рамка
        // обещает «сюда уйдёт Enter», а одобрение не срабатывает (см. paneFocus).
        focusPane(tab.activeSessionId)
      }
      schedulePersistWorkspace(get)
    },

    nextTab: (delta) => {
      const { tabs, activeTabId } = get()
      if (tabs.length < 2) return
      const i = tabs.findIndex((t) => t.id === activeTabId)
      const next = tabs[(i + delta + tabs.length) % tabs.length]
      get().setActiveTab(next.id)
    },

    setActiveSession: (sessionId) => {
      setPartial((s) => {
        const tab = s.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
        if (!tab) return {}
        return {
          tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activeSessionId: sessionId } : t)),
          activeTabId: tab.id
        }
      })
      // Инвариант окна: в фокусе — та панель, которую ВИДНО. Если во вкладке
      // развёрнута другая, разворот переезжает сюда. Фокус на невидимой панели
      // означал бы, что Enter и Esc уходят туда, куда человек не смотрит, — а
      // Enter одобряет запуск команды. Правило живёт ЗДЕСЬ, потому что через эту
      // дверь проходят все: клик по панели, клик по строке, переезд, закрытие.
      const tab = get().tabs.find((t) => listLeaves(t.layout).includes(sessionId))
      if (tab) {
        const maxed = maximizedIn(useUiStore.getState(), tab.id)
        if (maxed && maxed !== sessionId) setMaximized(tab.id, sessionId)
      }
      emitBus('terminal:focus', { sessionId })
    },

    splitActive: async (dir, cwd) => {
      const state = get()
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return
      // Потолок в четыре панели — решение inc-17, и держать его должен тот, кто
      // панели создаёт. Раньше пятая панель заводила живую сессию, которой не
      // было места в дереве: терминал работал, в списке не значился, а Enter и
      // Esc адресовались именно ему. Пятая уходит НОВОЙ ВКЛАДКОЙ.
      if (listLeaves(tab.layout).length >= MAX_PANES) {
        useUiStore
          .getState()
          .toast(t('sess.maxPanesNewTab', { n: MAX_PANES }), 'info')
        await get().newTab(undefined, cwd)
        return
      }
      const current = state.sessions[tab.activeSessionId]
      const id = uid('s')
      const session = makeRuntime({
        id,
        profileId: current?.profileId ?? 'auto',
        // Папка своя, если её указали; иначе — та же, что у делимой панели.
        cwd: cwd || current?.cwd || ''
      })
      setPartial((s) => ({
        sessions: { ...s.sessions, [id]: session },
        tabs: s.tabs.map((t) =>
          t.id !== tab.id
            ? t
            : {
                ...t,
                // Пока раскладка не тронута руками, число панелей само
                // выбирает вид: одна — во весь экран, две-три — колонками,
                // четыре — сетка 2×2. Как только человек протянул разделитель
                // или сложил панели по-своему, дерево перестаёт совпадать с
                // автоматическим — и мы больше в него не лезем. Отдельного
                // «замка» для этого не нужно: несовпадение и есть замок.
                layout:
                  autoLayout([...listLeaves(t.layout), id]) && isAutoLayout(t.layout)
                    ? (autoLayout([...listLeaves(t.layout), id]) as SplitNode)
                    : replaceLeaf(t.layout, tab.activeSessionId, {
                        type: 'split',
                        dir,
                        ratio: 0.5,
                        a: { type: 'leaf', sessionId: tab.activeSessionId },
                        b: { type: 'leaf', sessionId: id }
                      }),
                activeSessionId: id
              }
        )
      }))
      // Просили ещё одну панель — значит, просили увидеть раскладку. Оставить
      // разворот значило бы завести живой терминал, которого не видно, и отдать
      // ему Enter: ровно то, что чинилось потолком в четыре панели.
      setMaximized(tab.id, null)
      get().setActiveSession(id)
      await spawnSession(setPartial, session)
      focusPane(id)
      schedulePersistWorkspace(get)
    },

    splitBeside: async (targetSessionId, side, cwd) => {
      const state = get()
      const tab = state.tabs.find((t) => listLeaves(t.layout).includes(targetSessionId))
      if (!tab) return
      if (listLeaves(tab.layout).length >= MAX_PANES) {
        useUiStore
          .getState()
          .toast(t('sess.maxPanesNewTab', { n: MAX_PANES }), 'info')
        await get().newTab(undefined, cwd)
        return
      }
      const current = state.sessions[targetSessionId]
      const id = uid('s')
      const session = makeRuntime({
        id,
        profileId: current?.profileId ?? 'auto',
        cwd: cwd || current?.cwd || ''
      })
      setPartial((s) => ({
        sessions: { ...s.sessions, [id]: session },
        tabs: s.tabs.map((t) =>
          t.id !== tab.id
            ? t
            : {
                ...t,
                layout: placeBeside(t.layout, targetSessionId, id, side, isAutoLayout(t.layout)),
                activeSessionId: id
              }
        )
      }))
      // Просили ещё одну панель — значит, просили увидеть раскладку.
      setMaximized(tab.id, null)
      get().setActiveSession(id)
      await spawnSession(setPartial, session)
      focusPane(id)
      schedulePersistWorkspace(get)
    },

    movePaneNextTo: (sessionId, targetSessionId, side = 'right') => {
      if (sessionId === targetSessionId) return
      // Переезд в ЧУЖУЮ вкладку добавляет ей панель — потолок тот же, что у
      // деления. Внутри своей вкладки число панелей не меняется: там можно.
      const before = get()
      const fromTab = before.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
      const toTab = before.tabs.find((t) => listLeaves(t.layout).includes(targetSessionId))
      if (!fromTab || !toTab) return
      if (fromTab.id !== toTab.id && listLeaves(toTab.layout).length >= MAX_PANES) {
        useUiStore
          .getState()
          .toast(t('sess.maxPanes', { n: MAX_PANES }), 'error')
        return
      }
      // Вкладка отдала последнюю панель — она закроется, и её разворот вместе
      // с ней. Считаем ДО правки состояния: после неё вкладки уже нет.
      const donorEmpties =
        fromTab.id !== toTab.id && !removeLeaf(fromTab.layout, sessionId)
      setPartial((s) => {
        const from = s.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
        const to = s.tabs.find((t) => listLeaves(t.layout).includes(targetSessionId))
        if (!from || !to) return {}
        // Убираем лист из прежнего места и подставляем рядом с целью. Обе
        // операции — на дереве: ни одна сессия не создаётся и не гасится.
        const stripped = removeLeaf(from.layout, sessionId)
        const tabs = s.tabs
          .map((t) => {
            if (t.id === from.id && t.id === to.id) {
              // Внутри одной вкладки: сначала вынули, потом вставили рядом.
              const base = stripped ?? { type: 'leaf' as const, sessionId: targetSessionId }
              return {
                ...t,
                layout: placeBeside(base, targetSessionId, sessionId, side, isAutoLayout(t.layout)),
                activeSessionId: sessionId
              }
            }
            if (t.id === from.id) {
              // Вкладка осталась пустой — она уйдёт ниже вместе с фильтром.
              // Фокус в ней трогаем ТОЛЬКО если уехала именно фокусная панель:
              // иначе, вернувшись, человек нашёл бы рамку не там, где оставил.
              if (!stripped) return t
              const rest = listLeaves(stripped)
              return {
                ...t,
                layout: stripped,
                activeSessionId: rest.includes(t.activeSessionId) ? t.activeSessionId : rest[0]
              }
            }
            if (t.id === to.id) {
              return {
                ...t,
                layout: placeBeside(t.layout, targetSessionId, sessionId, side, isAutoLayout(t.layout)),
                activeSessionId: sessionId
              }
            }
            return t
          })
          // Вкладка, из которой забрали последнюю панель, закрывается: пустая
          // вкладка без единого терминала — мусор, а не место работы.
          .filter((t) => !(t.id === from.id && from.id !== to.id && !stripped))
        return { tabs, activeTabId: to.id }
      })
      // Опустевшая вкладка уходит — вместе с ней уходит и её разворот. Если она
      // осталась жить, но отдала именно развёрнутую панель, запись тоже снимаем:
      // иначе она указывала бы на панель, которой в этой вкладке больше нет.
      if (donorEmpties) forgetTabUi(fromTab.id)
      // Сырая карта, а не maximizedIn: тот уже видит новое дерево и честно
      // ответил бы «ничего не развёрнуто», оставив запись-призрак в памяти.
      else if (useUiStore.getState().maximizedByTab[fromTab.id] === sessionId) {
        setMaximized(fromTab.id, null)
      }
      // «Положить рядом с этой» — просьба увидеть обе. Оставить разворот значило
      // бы спрятать ту самую панель, на которую целились мышью.
      setMaximized(toTab.id, null)
      // Переехавшая панель — та, куда теперь уходят клавиши. Через общую дверь:
      // там же примиряется разворот вкладки-приёмника, иначе панель приехала бы
      // под развёрнутого соседа — живой терминал, которого не видно.
      get().setActiveSession(sessionId)
      focusPane(sessionId)
      schedulePersistWorkspace(get)
    },

    detachPane: (sessionId) => {
      const state = get()
      const from = state.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
      if (!from) return
      // Единственная панель вкладки и так сама по себе — выносить нечего.
      if (listLeaves(from.layout).length < 2) return
      // Те же правила, что и при закрытии: нетронутая раскладка пересобирается,
      // фокус уходит соседу. Разница одна — pty остаётся жить.
      const { layout, focus } = closePane(from.layout, sessionId)
      if (!layout) return
      const fresh: TabState = {
        id: uid('tab'),
        layout: { type: 'leaf', sessionId },
        activeSessionId: sessionId
      }
      setPartial((s) => {
        const leaves = listLeaves(layout)
        const wasFocused = from.activeSessionId === sessionId
        const tabs: TabState[] = []
        for (const t of s.tabs) {
          if (t.id !== from.id) {
            tabs.push(t)
            continue
          }
          tabs.push({
            ...t,
            layout,
            activeSessionId: wasFocused
              ? (focus && leaves.includes(focus) ? focus : leaves[0])
              : t.activeSessionId
          })
          // Новый стол встаёт СРАЗУ ЗА исходным: искать его будут рядом.
          tabs.push(fresh)
        }
        return { tabs }
      })
      // Развёрнутой она была в прежней вкладке — там записи больше не место.
      if (useUiStore.getState().maximizedByTab[from.id] === sessionId) {
        setMaximized(from.id, null)
      }
      const stay = get().tabs.find((t) => t.id === from.id)?.activeSessionId
      if (stay && state.activeTabId === from.id) {
        emitBus('terminal:focus', { sessionId: stay })
        focusPane(stay)
      }
      useUiStore.getState().toast(t('sess.detached'), 'success')
      schedulePersistWorkspace(get)
    },

    renameTab: (tabId, title) => {
      const own = title.trim()
      setPartial((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title: own || undefined } : t))
      }))
      schedulePersistWorkspace(get)
    },

    setSplitRatio: (tabId, path, ratio) => {
      setPartial((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layout: setRatioAt(t.layout, path, ratio) } : t))
      }))
      schedulePersistWorkspace(get)
    },

    closeSession: async (sessionId, opts) => {
      const save = opts?.save ?? true
      const session = get().sessions[sessionId]
      if (!session) return
      if (save && session.status !== 'starting') {
        try {
          await get().snapshotSession(sessionId)
        } catch (e) {
          console.error('snapshot on close failed', e)
        }
      }
      window.zarya.pty.kill(sessionId)
      disposeTerminal(sessionId)
      useBlocksStore.getState().clear(sessionId)
      // Следы закрытой панели в картах интерфейса (сырой режим, режим строки,
      // черновик строки ввода) — мусор: сессии больше нет, а записи остались бы
      // до конца работы приложения. Беседа убирается там же: висящий гейт без
      // своей карточки решить нечем, а вложения и автопилот мёртвой панели
      // воскресали при восстановлении сессии — она открывается под тем же id.
      forgetSessionUi(sessionId)
      forgetPaneDraft(sessionId)
      forgetPaneHistory(sessionId)
      useAiStore.getState().forgetSession(sessionId)
      /** Кому уйдут Enter и Esc после закрытия. Считается внутри set, отдаётся наружу. */
      let handOver: string | null = null
      /** Вкладка, которая закрылась вместе с последней панелью. */
      let closedTabId: string | null = null
      setPartial((s) => {
        const sessions = { ...s.sessions }
        delete sessions[sessionId]
        let tabs = s.tabs
        let activeTabId = s.activeTabId
        const tab = s.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
        if (tab) {
          // Раскладка пересобирается только если её не трогали руками, а фокус
          // уходит СОСЕДНЕЙ панели, а не «никуда» (см. paneTree.closePane).
          const { layout, focus } = closePane(tab.layout, sessionId)
          if (!layout) {
            tabs = s.tabs.filter((t) => t.id !== tab.id)
            closedTabId = tab.id
            if (activeTabId === tab.id) {
              const next = tabs[tabs.length - 1]
              activeTabId = next?.id ?? null
              handOver = next?.activeSessionId ?? null
            }
          } else {
            const leaves = listLeaves(layout)
            const wasFocused = tab.activeSessionId === sessionId
            const nextActive = wasFocused
              ? (focus && leaves.includes(focus) ? focus : leaves[0])
              : tab.activeSessionId
            if (wasFocused && tab.id === activeTabId) handOver = nextActive
            tabs = s.tabs.map((t) => (t.id === tab.id ? { ...t, layout, activeSessionId: nextActive } : t))
          }
        }
        return { sessions, tabs, activeTabId }
      })
      // Разворот принадлежит вкладке: закрылась развёрнутая панель — вкладка
      // возвращается к раскладке; закрылась вся вкладка — запись уходит с ней.
      if (closedTabId) forgetTabUi(closedTabId)
      for (const [tabId, sid] of Object.entries(useUiStore.getState().maximizedByTab)) {
        if (sid === sessionId) setMaximized(tabId, null)
      }
      if (handOver) {
        // Через общий путь, а не «руками»: там же живёт правило «фокус и то, что
        // видно, обязаны сходиться». Фокус — это не только рамка: беседа и лента
        // следуют за панелью, а курсор уезжает туда, где можно печатать.
        get().setActiveSession(handOver)
        focusPane(handOver)
      }
      await get().refreshSavedList()
      schedulePersistWorkspace(get)
    },

    restartSession: async (sessionId) => {
      const session = get().sessions[sessionId]
      if (!session) return
      const fresh = { ...session, status: 'starting' as const, exitCode: undefined }
      setPartial((s) => ({ sessions: { ...s.sessions, [sessionId]: fresh } }))
      getTerminal(sessionId)?.term.writeln('')
      await spawnSession(setPartial, fresh)
    },

    restoreSaved: async (savedId) => {
      const state = get()
      if (state.sessions[savedId]) {
        state.setActiveSession(savedId)
        return
      }
      // Guard against a double-click (or any rapid re-invocation) racing
      // through the async gap below and spawning two sessions for the same id.
      if (restoringIds.has(savedId)) return
      restoringIds.add(savedId)
      try {
        const snap = await window.zarya.sessions.loadSnapshot(savedId)
        if (!snap) {
          useUiStore.getState().toast(t('sess.snapshotMissing'), 'error')
          return
        }
        useBlocksStore.getState().setBlocks(savedId, snap.blocks)
        if (snap.scrollback) setPendingRestore(savedId, snap.scrollback)
        const session = makeRuntime({
          id: savedId,
          title: restoredTitle(snap.meta.title),
          customTitle: snap.meta.title !== LEGACY_DEFAULT_TITLE,
          profileId: snap.meta.profileId,
          shellName: snap.meta.shellName,
          shellIcon: snap.meta.shellIcon,
          cwd: snap.meta.cwd,
          createdAt: snap.meta.createdAt,
          pinned: snap.meta.pinned,
          favorite: snap.meta.favorite,
          restored: true
        })
        const tab: TabState = {
          id: uid('tab'),
          layout: { type: 'leaf', sessionId: savedId },
          activeSessionId: savedId
        }
        setPartial((s) => ({
          sessions: { ...s.sessions, [savedId]: session },
          tabs: [...s.tabs, tab],
          activeTabId: tab.id
        }))
        await spawnSession(setPartial, session)
        emitBus('session:restored', { sessionId: savedId })
        schedulePersistWorkspace(get)
      } finally {
        restoringIds.delete(savedId)
      }
    },

    refreshSavedList: async () => {
      set({ savedList: await window.zarya.sessions.list() })
    },

    toggleFlag: async (savedId, flag) => {
      const state = get()
      const runtime = state.sessions[savedId]
      const saved = state.savedList.find((m) => m.id === savedId)
      const current = runtime ? runtime[flag] : (saved?.[flag] ?? false)
      const value = !current
      if (runtime) {
        setPartial((s) => ({
          sessions: { ...s.sessions, [savedId]: { ...runtime, [flag]: value } }
        }))
        // Make sure a snapshot exists before flagging a live session.
        await get().snapshotSession(savedId)
      }
      await window.zarya.sessions.setFlag(savedId, flag, value)
      await get().refreshSavedList()
    },

    renameSession: async (sessionId, title) => {
      const runtime = get().sessions[sessionId]
      if (runtime) {
        setPartial((s) => ({
          sessions: { ...s.sessions, [sessionId]: { ...runtime, title, customTitle: true } }
        }))
      }
      await window.zarya.sessions.rename(sessionId, title)
      await get().refreshSavedList()
    },

    deleteSaved: async (savedId) => {
      await window.zarya.sessions.delete(savedId)
      await get().refreshSavedList()
    },

    updateCwd: (sessionId, cwd) => {
      setPartial((s) => {
        const cur = s.sessions[sessionId]
        if (!cur || cur.cwd === cwd) return {}
        const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: { ...cur, cwd, title: cur.customTitle ? cur.title : base }
          }
        }
      })
    },

    snapshotSession: async (sessionId) => {
      const session = get().sessions[sessionId]
      if (!session) return
      const handle = getTerminal(sessionId)
      const maxLines = getSettings().sessions.scrollbackSaveLines
      let scrollback = ''
      if (handle) {
        try {
          scrollback = handle.serialize(maxLines)
        } catch (e) {
          console.error('serialize failed', e)
        }
      } else {
        scrollback = peekPendingRestore(sessionId) ?? ''
      }
      const snap: SessionSnapshot = {
        meta: buildMeta(session, useBlocksStore.getState().bySession[sessionId] ?? []),
        scrollback,
        blocks: snapshotBlocks(sessionId)
      }
      await window.zarya.sessions.saveSnapshot(snap)
    },

    snapshotAll: async () => {
      const ids = Object.keys(get().sessions)
      for (const id of ids) {
        try {
          await get().snapshotSession(id)
        } catch (e) {
          console.error('snapshot failed for', id, e)
        }
      }
      if (ids.length) await get().refreshSavedList()
    },

    activeSessionId: () => {
      const { tabs, activeTabId } = get()
      return tabs.find((t) => t.id === activeTabId)?.activeSessionId ?? null
    }
  }
})

// QA-хуки ставятся только в окне: этот файл импортируют и юнит-тесты, где
// window нет вовсе — без проверки падал бы сам импорт.
if (typeof window !== 'undefined') {
  // QA hook: force a full persist (terminal snapshots + workspace + conversations)
  // so a restart-restore test is deterministic without relying on graceful close.
  ;(window as unknown as { __zaryaPersistAll?: () => Promise<void> }).__zaryaPersistAll = async () => {
    await useSessionsStore.getState().snapshotAll()
    const { tabs, activeTabId } = useSessionsStore.getState()
    await window.zarya.sessions.saveWorkspace({ tabs, activeTabId })
    await runQuitFlushers()
  }

  // QA hook: inspect the tab/session model from the offscreen harness.
  ;(window as unknown as { __zaryaDumpSessions?: () => unknown }).__zaryaDumpSessions = () => {
    const s = useSessionsStore.getState()
    return {
      activeTabId: s.activeTabId,
      activeSessionId: s.activeSessionId(),
      tabs: s.tabs.map((t) => ({ id: t.id, activeSessionId: t.activeSessionId, leaves: listLeaves(t.layout) })),
      sessions: Object.values(s.sessions).map((x) => ({ id: x.id, title: x.title, cwd: x.cwd, status: x.status }))
    }
  }

  // QA hooks: drive terminals from the offscreen harness (create / run a shell
  // command / split / close) so a full-app QA sweep can exercise the real PTY.
  ;(window as unknown as { __zaryaNewTerminal?: (cwd?: string) => Promise<string> }).__zaryaNewTerminal = (
    cwd
  ) => useSessionsStore.getState().newTab(undefined, cwd)
  ;(window as unknown as { __zaryaRunShell?: (cmd: string, sessionId?: string) => string | null }).__zaryaRunShell =
    (cmd, sessionId) => {
      const sid = sessionId || useSessionsStore.getState().activeSessionId()
      if (sid) window.zarya.pty.write(sid, cmd + '\r')
      return sid
    }
  /**
   * Текст терминала как его видит человек, и фокус конкретной панели. Нужны
   * многопанельным прогонам: «шелл ответил» проверяется тем, что он ОТВЕТИЛ, а
   * адресат клавиш — тем, что фокус переставили явно, а не догадкой.
   */
  ;(window as unknown as { __zaryaTermText?: (sessionId: string) => string }).__zaryaTermText = (
    sessionId
  ) => getTerminal(sessionId)?.serialize(200) ?? ''
  ;(window as unknown as { __zaryaFocusPane?: (sessionId: string) => void }).__zaryaFocusPane = (
    sessionId
  ) => useSessionsStore.getState().setActiveSession(sessionId)
  ;(
    window as unknown as { __zaryaSplitActive?: (dir: SplitDirection, cwd?: string) => Promise<void> }
  ).__zaryaSplitActive =
    (dir, cwd) => useSessionsStore.getState().splitActive(dir, cwd)
  ;(
    window as unknown as { __zaryaMovePane?: (sid: string, target: string) => void }
  ).__zaryaMovePane = (sid, target) => useSessionsStore.getState().movePaneNextTo(sid, target)
  ;(window as unknown as { __zaryaCloseSession?: (sid: string) => Promise<void> }).__zaryaCloseSession = (sid) =>
    useSessionsStore.getState().closeSession(sid, { save: false })
  /**
   * Снимкам для README: подписать панель нейтрально. В документации не должно
   * быть ни чужих папок, ни личных путей — а настоящие берутся из настоящей
   * файловой системы, какая есть на машине.
   */
  ;(
    window as unknown as { __zaryaRenameForShot?: (sid: string, title: string, cwd: string) => void }
  ).__zaryaRenameForShot = (sid, title, cwd) => {
    useSessionsStore.setState((s) => {
      const cur = s.sessions[sid]
      if (!cur) return {}
      return { sessions: { ...s.sessions, [sid]: { ...cur, title, customTitle: true, cwd } } }
    })
  }
}

async function restoreWorkspace(
  ws: WorkspaceState,
  setPartial: (fn: (s: SessionsState) => Partial<SessionsState>) => void,
  get: () => SessionsState
): Promise<boolean> {
  let restored = false
  /** Старый id вкладки → новый: по нему возвращается та вкладка, где работали. */
  const tabIdMap = new Map<string, string>()
  for (const tab of ws.tabs) {
    const idMap = new Map<string, string>()
    const sessions: RuntimeSession[] = []
    for (const sid of listLeaves(tab.layout)) {
      const snap = await window.zarya.sessions.loadSnapshot(sid)
      if (snap) {
        idMap.set(sid, sid)
        useBlocksStore.getState().setBlocks(sid, snap.blocks)
        if (snap.scrollback) setPendingRestore(sid, snap.scrollback)
        sessions.push(
          makeRuntime({
            id: sid,
            title: restoredTitle(snap.meta.title),
            customTitle: snap.meta.title !== LEGACY_DEFAULT_TITLE,
            profileId: snap.meta.profileId,
            shellName: snap.meta.shellName,
            shellIcon: snap.meta.shellIcon,
            cwd: snap.meta.cwd,
            createdAt: snap.meta.createdAt,
            pinned: snap.meta.pinned,
            favorite: snap.meta.favorite,
            restored: true
          })
        )
      } else {
        const freshId = uid('s')
        idMap.set(sid, freshId)
        sessions.push(makeRuntime({ id: freshId }))
      }
    }
    const layout = mapLeaves(tab.layout, (old) => idMap.get(old) ?? old)
    const newTab: TabState = {
      id: uid('tab'),
      layout,
      activeSessionId: idMap.get(tab.activeSessionId) ?? listLeaves(layout)[0],
      // Имя рабочего стола переживает перезапуск — иначе названные столы после
      // возвращения снова становились безымянными.
      title: tab.title
    }
    tabIdMap.set(tab.id, newTab.id)
    setPartial((s) => ({
      sessions: {
        ...s.sessions,
        ...Object.fromEntries(sessions.map((x) => [x.id, x]))
      },
      tabs: [...s.tabs, newTab],
      activeTabId: s.activeTabId ?? newTab.id
    }))
    for (const session of sessions) {
      await spawnSession(setPartial, session)
    }
    restored = true
  }
  // Возвращаемся ТУДА, где остановились. Раньше активной становилась первая
  // восстановленная вкладка, а сохранённый выбор не читался вовсе: человек с
  // тремя вкладками после перезапуска каждый раз попадал не в свою.
  const wanted = ws.activeTabId ? tabIdMap.get(ws.activeTabId) : undefined
  if (wanted) {
    setPartial(() => ({ activeTabId: wanted }))
    const tab = get().tabs.find((t) => t.id === wanted)
    if (tab) emitBus('terminal:focus', { sessionId: tab.activeSessionId })
  }
  return restored
}
