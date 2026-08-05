import { beforeEach, describe, expect, it } from 'vitest'
import { setUiLang } from './uiLang'
import {
  applySubagentEvent,
  fmtElapsed,
  fmtTokens,
  summarizeWave,
  type SubagentRun
} from '@/features/ai/subagents'

/**
 * Event shapes here are copied from a real Claude Code turn with three parallel
 * subagents (see inc-13): `task_started` carries the description, `task_progress`
 * carries the SDK's own token/tool/duration counts, `task_updated` carries only a
 * status patch. Every number the indicator shows must come from those events —
 * a plausible-but-invented figure would be worse than showing nothing.
 */
const started = (taskId: string, description: string) => ({
  taskId,
  phase: 'started' as const,
  description,
  subagentType: 'general-purpose'
})
const progress = (taskId: string, tokens: number, over: Record<string, unknown> = {}) => ({
  taskId,
  phase: 'progress' as const,
  totalTokens: tokens,
  toolUses: 1,
  durationMs: 3440,
  lastTool: 'Bash',
  ...over
})
const done = (taskId: string) => ({ taskId, phase: 'done' as const })

const fold = (events: Parameters<typeof applySubagentEvent>[1][], now = 1000) =>
  events.reduce<Record<string, SubagentRun>>((acc, e) => applySubagentEvent(acc, e, now), {})

describe('applySubagentEvent', () => {
  it('tracks a wave of parallel subagents', () => {
    const runs = fold([started('a', 'Count files'), started('b', 'Read version'), started('c', 'Count lines')])
    expect(Object.keys(runs)).toHaveLength(3)
    expect(runs.a.description).toBe('Count files')
  })

  it('keeps the last known description when an event omits it', () => {
    // task_updated carries only { status } — blanking the row would make a
    // finished subagent go anonymous.
    const runs = fold([started('a', 'Reading package.json'), done('a')])
    expect(runs.a.description).toBe('Reading package.json')
    expect(runs.a.done).toBe(true)
  })

  it('never un-finishes a task', () => {
    const runs = fold([started('a', 'x'), done('a'), progress('a', 500)])
    expect(runs.a.done).toBe(true)
  })
})

describe('summarizeWave', () => {
  it('counts done vs total and sums the SDK-reported tokens', () => {
    const runs = fold([
      started('a', 'one'),
      started('b', 'two'),
      progress('a', 31899),
      progress('b', 31934),
      done('a')
    ])
    const w = summarizeWave(runs, 5000)
    expect(w.total).toBe(2)
    expect(w.done).toBe(1)
    expect(w.tokens).toBe(63833)
  })

  it('reports the slowest member as the wave duration', () => {
    const runs = fold([
      started('a', 'one'),
      started('b', 'two'),
      progress('a', 10, { durationMs: 3000 }),
      progress('b', 10, { durationMs: 9000 }),
      done('a'),
      done('b')
    ])
    expect(summarizeWave(runs, 0).elapsedMs).toBe(9000)
  })

  it('keeps the timer moving for a live task between SDK updates', () => {
    // The SDK last said 3.4s, but 30s of wall clock have passed — a frozen
    // readout would suggest the wave stalled.
    const runs = fold([started('a', 'one'), progress('a', 10, { durationMs: 3440 })], 1000)
    expect(summarizeWave(runs, 31_000).elapsedMs).toBe(30_000)
  })

  it('freezes a finished task at the duration the SDK reported', () => {
    const runs = fold([started('a', 'one'), progress('a', 10, { durationMs: 3440 }), done('a')], 1000)
    expect(summarizeWave(runs, 999_000).elapsedMs).toBe(3440)
  })

  it('lists only the still-running ones', () => {
    const runs = fold([started('a', 'one'), started('b', 'two'), done('a')])
    expect(summarizeWave(runs, 0).running.map((r) => r.taskId)).toEqual(['b'])
  })

  it('an empty wave is empty, not NaN', () => {
    const w = summarizeWave({}, 1000)
    expect(w).toMatchObject({ total: 0, done: 0, tokens: 0, elapsedMs: 0 })
  })
})

/**
 * Исход задачи. Движок называет его словом — `completed`, `failed`, `stopped`
 * (последнее приходит и как `patch.status: 'killed'`). Раньше не читалось
 * НИЧЕГО из этого: упавшей, остановленной и успешной рисовался один зелёный
 * чек, и «18 из 18» при двух упавших было обычным делом.
 */
describe('исход задачи', () => {
  const settle = (
    taskId: string,
    status: 'completed' | 'failed' | 'stopped',
    summary?: string
  ) => ({ taskId, phase: 'done' as const, status, summary })

  it('упавшая и остановленная отделены от успешных', () => {
    const runs = fold([
      started('a', 'раз'),
      started('b', 'два'),
      started('c', 'три'),
      settle('a', 'completed'),
      settle('b', 'failed', 'не нашёл файл'),
      settle('c', 'stopped')
    ])
    const w = summarizeWave(runs, 0)
    expect(w.done).toBe(3)
    expect(w.failed.map((r) => r.taskId)).toEqual(['b', 'c'])
    expect(w.failed[0].summary).toBe('не нашёл файл')
  })

  it('успех в отдельный список не попадает — его итог и есть счётчик', () => {
    const runs = fold([started('a', 'раз'), settle('a', 'completed')])
    expect(summarizeWave(runs, 0).failed).toEqual([])
  })

  it('исход не затирается последующим событием без слов', () => {
    // Последним часто приходит `task_updated` без статуса. Если бы он обнулял
    // исход, неудача тихо превращалась бы в успех — ровно та ложь, от которой
    // всё это и делалось.
    const runs = fold([started('a', 'раз'), settle('a', 'failed', 'упал'), done('a')])
    expect(runs.a.status).toBe('failed')
    expect(runs.a.summary).toBe('упал')
    expect(summarizeWave(runs, 0).failed).toHaveLength(1)
  })

  it('задача без исхода вовсе неудачей не считается', () => {
    // Старый движок статуса не шлёт. Молчание — это «не знаем», а не «упало»:
    // придумать неудачу так же нечестно, как её спрятать.
    const runs = fold([started('a', 'раз'), done('a')])
    expect(summarizeWave(runs, 0).failed).toEqual([])
  })
})

describe('род задачи', () => {
  it('воркфлоу узнаётся и волна перестаёт звать всех агентами', () => {
    const runs = fold([
      { ...started('a', 'раз'), taskType: 'local_agent' },
      { ...started('b', 'сборка'), taskType: 'local_workflow', workflowName: 'review-changes' }
    ])
    expect(summarizeWave(runs, 0).mixed).toBe(true)
    expect(runs.b.workflowName).toBe('review-changes')
  })

  it('одни субагенты — волна остаётся волной агентов', () => {
    const runs = fold([
      { ...started('a', 'раз'), taskType: 'local_agent' },
      { ...started('b', 'два'), taskType: 'local_agent' }
    ])
    expect(summarizeWave(runs, 0).mixed).toBe(false)
  })

  it('род приходит один раз и не теряется в следующих событиях', () => {
    // `task_type` движок шлёт только при запуске: если его не запомнить,
    // воркфлоу опознавался бы лишь в первый миг своей жизни.
    const runs = fold([
      { ...started('a', 'сборка'), taskType: 'local_workflow', workflowName: 'ship' },
      progress('a', 100),
      done('a')
    ])
    expect(runs.a.taskType).toBe('local_workflow')
    expect(runs.a.workflowName).toBe('ship')
    expect(summarizeWave(runs, 0).mixed).toBe(true)
  })

  it('незнакомый род не глушится — он просто не агент', () => {
    // Белый список уже один раз проглотил Workflow целиком. Новое обязано
    // появляться на экране, а не исчезать до следующего разбора.
    const runs = fold([{ ...started('a', 'что-то новое'), taskType: 'remote_agent' }])
    expect(summarizeWave(runs, 0).total).toBe(1)
    expect(summarizeWave(runs, 0).mixed).toBe(true)
  })
})

describe('formatting', () => {
  // См. tests/uiLang.ts: без явного языка проверка зависит от локали машины.
  beforeEach(() => setUiLang('ru'))

  it('reads token counts the way the CLI does', () => {
    expect(fmtTokens(842)).toBe('842')
    expect(fmtTokens(31_899)).toBe('31.9K')
    expect(fmtTokens(1_100_000)).toBe('1.1M')
  })

  it('reads durations in the feed voice', () => {
    expect(fmtElapsed(6_000)).toBe('6с')
    expect(fmtElapsed(666_000)).toBe('11м 6с')
    expect(fmtElapsed(0)).toBe('0с')
    setUiLang('en')
    expect(fmtElapsed(6_000)).toBe('6s')
    expect(fmtElapsed(666_000)).toBe('11m 6s')
  })
})
