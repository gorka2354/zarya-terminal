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
import { emitBus, onBus } from '@/lib/bus'
import { useBlocksStore } from './blocksStore'
import { getSettings } from './settingsStore'
import { useUiStore } from './uiStore'
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

export function listLeaves(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.sessionId]
  return [...listLeaves(node.a), ...listLeaves(node.b)]
}

function replaceLeaf(node: SplitNode, sessionId: string, replacement: SplitNode): SplitNode {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? replacement : node
  }
  return {
    ...node,
    a: replaceLeaf(node.a, sessionId, replacement),
    b: replaceLeaf(node.b, sessionId, replacement)
  }
}

function removeLeaf(node: SplitNode, sessionId: string): SplitNode | null {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? null : node
  }
  const a = removeLeaf(node.a, sessionId)
  const b = removeLeaf(node.b, sessionId)
  if (a && b) return { ...node, a, b }
  return a ?? b
}

function mapLeaves(node: SplitNode, map: (id: string) => string): SplitNode {
  if (node.type === 'leaf') return { type: 'leaf', sessionId: map(node.sessionId) }
  return { ...node, a: mapLeaves(node.a, map), b: mapLeaves(node.b, map) }
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
  splitActive: (dir: SplitDirection) => Promise<void>
  setSplitRatio: (tabId: string, path: SplitNode, ratio: number) => void
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
      useUiStore.getState().toast(`Не удалось запустить shell: ${res.error ?? '?'}`, 'error')
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

function makeRuntime(partial: Partial<RuntimeSession> & { id: string }): RuntimeSession {
  const cwdBase = partial.cwd?.split(/[\\/]/).filter(Boolean).pop()
  return {
    title: cwdBase ?? 'Терминал',
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
        requestAnimationFrame(() => getTerminal(tab.activeSessionId)?.focus())
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
      emitBus('terminal:focus', { sessionId })
    },

    splitActive: async (dir) => {
      const state = get()
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return
      const current = state.sessions[tab.activeSessionId]
      const id = uid('s')
      const session = makeRuntime({
        id,
        profileId: current?.profileId ?? 'auto',
        cwd: current?.cwd ?? ''
      })
      setPartial((s) => ({
        sessions: { ...s.sessions, [id]: session },
        tabs: s.tabs.map((t) =>
          t.id !== tab.id
            ? t
            : {
                ...t,
                layout: replaceLeaf(t.layout, tab.activeSessionId, {
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
      await spawnSession(setPartial, session)
      schedulePersistWorkspace(get)
    },

    setSplitRatio: (tabId, node, ratio) => {
      setPartial((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t
          const patch = (n: SplitNode): SplitNode => {
            if (n === node && n.type === 'split') return { ...n, ratio }
            if (n.type === 'split') return { ...n, a: patch(n.a), b: patch(n.b) }
            return n
          }
          return { ...t, layout: patch(t.layout) }
        })
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
      setPartial((s) => {
        const sessions = { ...s.sessions }
        delete sessions[sessionId]
        let tabs = s.tabs
        let activeTabId = s.activeTabId
        const tab = s.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
        if (tab) {
          const newLayout = removeLeaf(tab.layout, sessionId)
          if (!newLayout) {
            tabs = s.tabs.filter((t) => t.id !== tab.id)
            if (activeTabId === tab.id) activeTabId = tabs[tabs.length - 1]?.id ?? null
          } else {
            const leaves = listLeaves(newLayout)
            tabs = s.tabs.map((t) =>
              t.id === tab.id
                ? {
                    ...t,
                    layout: newLayout,
                    activeSessionId: leaves.includes(t.activeSessionId)
                      ? t.activeSessionId
                      : leaves[0]
                  }
                : t
            )
          }
        }
        return { sessions, tabs, activeTabId }
      })
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
          useUiStore.getState().toast('Снапшот сессии не найден', 'error')
          return
        }
        useBlocksStore.getState().setBlocks(savedId, snap.blocks)
        if (snap.scrollback) setPendingRestore(savedId, snap.scrollback)
        const session = makeRuntime({
          id: savedId,
          title: snap.meta.title,
          customTitle: true,
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

async function restoreWorkspace(
  ws: WorkspaceState,
  setPartial: (fn: (s: SessionsState) => Partial<SessionsState>) => void,
  get: () => SessionsState
): Promise<boolean> {
  let restored = false
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
            title: snap.meta.title,
            customTitle: true,
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
      activeSessionId: idMap.get(tab.activeSessionId) ?? listLeaves(layout)[0]
    }
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
  return restored
}
