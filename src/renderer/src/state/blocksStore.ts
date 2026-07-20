import { create } from 'zustand'
import type { BlockRecord } from '@shared/types'

const MAX_BLOCKS_PER_SESSION = 500

interface BlocksState {
  bySession: Record<string, BlockRecord[]>
  addBlock: (block: BlockRecord) => void
  updateBlock: (sessionId: string, blockId: string, patch: Partial<BlockRecord>) => void
  setBlocks: (sessionId: string, blocks: BlockRecord[]) => void
  clear: (sessionId: string) => void
  lastBlock: (sessionId: string) => BlockRecord | undefined
  lastFailedBlock: (sessionId: string) => BlockRecord | undefined
}

export const useBlocksStore = create<BlocksState>((set, get) => ({
  bySession: {},

  addBlock: (block) =>
    set((s) => {
      const list = [...(s.bySession[block.sessionId] ?? []), block]
      if (list.length > MAX_BLOCKS_PER_SESSION) list.shift()
      return { bySession: { ...s.bySession, [block.sessionId]: list } }
    }),

  updateBlock: (sessionId, blockId, patch) =>
    set((s) => {
      const list = s.bySession[sessionId]
      if (!list) return s
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: list.map((b) => (b.id === blockId ? { ...b, ...patch } : b))
        }
      }
    }),

  setBlocks: (sessionId, blocks) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: blocks } })),

  clear: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),

  lastBlock: (sessionId) => {
    const list = get().bySession[sessionId]
    return list?.[list.length - 1]
  },

  lastFailedBlock: (sessionId) => {
    const list = get().bySession[sessionId] ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].exitCode !== undefined && list[i].exitCode !== 0) return list[i]
    }
    return undefined
  }
}))
