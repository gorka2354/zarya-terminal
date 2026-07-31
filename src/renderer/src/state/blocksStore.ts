import { create } from 'zustand'
import { useSessionsStore } from './sessionsStore'
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

// QA-хуки ставятся только в окне: файл импортируют и юнит-тесты, где window
// нет вовсе — без проверки падал бы сам импорт.
if (typeof window !== 'undefined') {
  /**
   * Прогону скорости: набить ленту так, как она выглядит к вечеру рабочего дня.
   *
   * Через настоящую оболочку сотня блоков набирается минуту, и мерили бы мы
   * скорость pty, а не скорость ленты. Здесь сцена собирается сразу и одинаково —
   * иначе цифры «до» и «после» не сравнить.
   */
  ;(
    window as unknown as {
      __zaryaSeedBlocks?: (sessionId: string, count: number, lines: number) => number
    }
  ).__zaryaSeedBlocks = (sessionId, count, lines) => {
    const now = Date.now()
    // Папка — та же, что у самой панели: в снимках для README путь в блоке не
    // должен спорить с путём в шапке.
    const cwd = useSessionsStore.getState().sessions[sessionId]?.cwd || '~/code/project'
    const CMDS = ['npm run build', 'git status', 'npm test -- --watch=false', 'git log --oneline -5']
    const OUT = [
      ['vite v7.2.4 building for production...', '✓ 412 modules transformed.', 'dist/index.js  184.20 kB', '✓ built in 3.14s'],
      ['On branch main', "Your branch is up to date with 'origin/main'.", 'nothing to commit, working tree clean', ''],
      ['✓ src/store.test.ts (14)', '✓ src/router.test.ts (9)', 'Test Files  2 passed (2)', '     Tests  23 passed (23)'],
      ['a41c9f2 feat(store): batch writes', '7db3e10 fix(router): keep query on back', '2c8ee54 chore: bump deps', 'f10a993 docs: update readme']
    ]
    const list: BlockRecord[] = Array.from({ length: count }, (_, i) => ({
      id: `seed-${sessionId}-${i}`,
      sessionId,
      command: CMDS[i % CMDS.length],
      cwd,
      startedAt: now - (count - i) * 1000,
      endedAt: now - (count - i) * 1000 + 400,
      exitCode: i % 7 === 0 ? 1 : 0,
      // Вывод похож на настоящий и не на языке интерфейса: этими блоками
      // заполняются кадры для витрины, а «строка вывода 3 блока 0» в кадре
      // сообщает читателю только то, что это подделка.
      output: OUT[i % OUT.length].slice(0, lines).join('\n'),
      outputTruncated: false
    }))
    useBlocksStore.getState().setBlocks(sessionId, list)
    return list.length
  }

  // QA hook: inspect command blocks (command/exitCode/cwd/output) per session from
  // the offscreen harness. Returns all sessions when no id is given.
  ;(window as unknown as { __zaryaDumpBlocks?: (sessionId?: string) => unknown }).__zaryaDumpBlocks = (
    sessionId
  ) => {
    const by = useBlocksStore.getState().bySession
    const slim = (b: BlockRecord): unknown => ({
      command: b.command,
      cwd: b.cwd,
      exitCode: b.exitCode,
      output: (b.output || '').slice(0, 400),
      endedAt: b.endedAt
    })
    if (sessionId) return (by[sessionId] ?? []).map(slim)
    const out: Record<string, unknown[]> = {}
    for (const [sid, list] of Object.entries(by)) out[sid] = list.map(slim)
    return out
  }
  /**
   * Прогону: блок, который ПРЯМО СЕЙЧАС выполняется, с заданным выводом.
   *
   * Проверять строку скачивания настоящим `git clone` значило бы завести тест,
   * который ходит в сеть и зависит от чужого репозитория; а весь смысл проверки
   * — в том, как лента показывает вывод, а не в том, откуда он взялся.
   */
  ;(
    window as unknown as {
      __zaryaSeedRunningBlock?: (sessionId: string, output: string, command?: string) => string
    }
  ).__zaryaSeedRunningBlock = (sessionId, output, command) => {
    const id = `running-${sessionId}`
    const cwd = useSessionsStore.getState().sessions[sessionId]?.cwd || '~/code/project'
    useBlocksStore.getState().setBlocks(sessionId, [
      {
        id,
        sessionId,
        command: command || 'git clone https://example.com/repo.git',
        cwd,
        startedAt: Date.now() - 3000,
        output,
        outputTruncated: false
      }
    ])
    return id
  }

}
