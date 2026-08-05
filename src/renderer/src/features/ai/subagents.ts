/**
 * Subagent wave — «4/18 агентов · 11м 6с · ↓1.1M токенов».
 *
 * Every number here comes from the SDK's own task telemetry (see the `subagent`
 * event): tokens, tool calls and duration are counted by Claude Code per task.
 * Nothing is estimated. An indicator showing plausible-but-invented figures
 * would be worse than none — the same class of problem as a gate that lies
 * about its mode.
 */

export interface SubagentRun {
  taskId: string
  /** The Agent tool_use this task belongs to — lets the feed hide the now-redundant card. */
  toolUseId?: string
  /** What it is doing right now — the SDK refreshes this as it works. */
  description?: string
  subagentType?: string
  totalTokens?: number
  toolUses?: number
  durationMs?: number
  lastTool?: string
  done: boolean
  /**
   * Чем кончилась — слово движка.
   *
   * Раньше исход не читался вовсе: упавшая, остановленная и успешная задачи
   * получали один зелёный чек. «18 из 18» при двух упавших — это неправда,
   * сказанная уверенным тоном.
   */
  status?: 'completed' | 'failed' | 'stopped'
  /** Чем кончилась по существу — пересказ движка (или его же текст ошибки). */
  summary?: string
  /** Род задачи: `local_agent`, `local_workflow`, что появится дальше. */
  taskType?: string
  /** Имя воркфлоу из его скрипта. */
  workflowName?: string
  /** Задачу увели в фон: ход пошёл дальше, а она осталась работать. */
  backgrounded?: boolean
  /** When we first heard about it, for a live timer between SDK updates. */
  startedAt: number
}

export interface WaveSummary {
  total: number
  done: number
  /** Sum of per-task tokens the SDK reported. */
  tokens: number
  /** Longest-running task — the wave is as slow as its slowest member. */
  elapsedMs: number
  /** Still-running descriptions, for the detail list. */
  running: SubagentRun[]
  /**
   * Кончившиеся НЕ успехом — упавшие и остановленные, в порядке появления.
   *
   * Отдельным списком, потому что показывать их надо всегда: успешные можно
   * свернуть в счётчик, неудачу — нельзя. Ради неё человек и смотрит.
   */
  failed: SubagentRun[]
  /**
   * Сколько сломалось и сколько прекратили — ПОРОЗНЬ.
   *
   * Разница не в оттенке: упала задача сама, а остановил её человек. Сложить их
   * в одно «не смогли» значит обвинить агента в чужом решении — и показать
   * тревогу там, где всё пошло ровно так, как велели.
   */
  broken: number
  halted: number
  /** Есть ли среди задач хоть одна не-субагент (воркфлоу и прочее). */
  mixed: boolean
}

/** Fold one driver event into the map of runs. */
export function applySubagentEvent(
  runs: Record<string, SubagentRun>,
  ev: {
    taskId: string
    toolUseId?: string
    phase: 'started' | 'progress' | 'done'
    description?: string
    subagentType?: string
    totalTokens?: number
    toolUses?: number
    durationMs?: number
    lastTool?: string
    status?: 'completed' | 'failed' | 'stopped'
    summary?: string
    taskType?: string
    workflowName?: string
    backgrounded?: boolean
  },
  now: number
): Record<string, SubagentRun> {
  const prev = runs[ev.taskId]
  const next: SubagentRun = {
    taskId: ev.taskId,
    toolUseId: ev.toolUseId ?? prev?.toolUseId,
    startedAt: prev?.startedAt ?? now,
    // Keep the last known value when an event omits a field: `task_updated`
    // carries only a status patch, and blanking the description there would
    // make finished rows go anonymous.
    description: ev.description ?? prev?.description,
    subagentType: ev.subagentType ?? prev?.subagentType,
    totalTokens: ev.totalTokens ?? prev?.totalTokens,
    toolUses: ev.toolUses ?? prev?.toolUses,
    durationMs: ev.durationMs ?? prev?.durationMs,
    lastTool: ev.lastTool ?? prev?.lastTool,
    // Исход не затирается пустотой: последним событием часто приходит
    // `task_updated` без слов, и неудача иначе тихо превратилась бы в успех.
    status: ev.status ?? prev?.status,
    summary: ev.summary ?? prev?.summary,
    taskType: ev.taskType ?? prev?.taskType,
    workflowName: ev.workflowName ?? prev?.workflowName,
    backgrounded: ev.backgrounded ?? prev?.backgrounded,
    done: ev.phase === 'done' || prev?.done === true
  }
  return { ...runs, [ev.taskId]: next }
}

/** Как назвать задачу одной строкой: имя воркфлоу, дело субагента, род. */
export function runLabel(r: SubagentRun): string {
  return r.workflowName || r.description || r.subagentType || t('feed.subagent')
}

/** Roll the runs up into the one line the feed shows. */
export function summarizeWave(runs: Record<string, SubagentRun>, now: number): WaveSummary {
  const all = Object.values(runs)
  let tokens = 0
  let elapsed = 0
  let mixed = false
  const running: SubagentRun[] = []
  const failed: SubagentRun[] = []
  for (const r of all) {
    tokens += r.totalTokens ?? 0
    // A finished task keeps the SDK's own duration; a live one is measured from
    // when we first saw it, so the timer ticks between updates instead of
    // freezing on the last reported value.
    const dur = r.done ? (r.durationMs ?? 0) : Math.max(r.durationMs ?? 0, now - r.startedAt)
    if (dur > elapsed) elapsed = dur
    if (!r.done) running.push(r)
    else if (r.status === 'failed' || r.status === 'stopped') failed.push(r)
    // «Агентов» — только когда это и правда агенты. Воркфлоу в том же счётчике
    // назвался бы агентом, которым он не является.
    if (r.taskType && r.taskType !== 'local_agent') mixed = true
  }
  return {
    total: all.length,
    done: all.filter((r) => r.done).length,
    tokens,
    elapsedMs: elapsed,
    running,
    failed,
    broken: failed.filter((r) => r.status === 'failed').length,
    halted: failed.filter((r) => r.status === 'stopped').length,
    mixed
  }
}

/** «1.1M» / «31.9K» / «842» — compact, like the CLI's own readout. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** «11м 6с» / «6с» — duration in the feed's voice. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m ? t('sub.min', { m, s }) : t('sub.sec', { s })
}

/**
 * tool_use ids the wave already accounts for. The feed hides those cards: an
 * «Agent» card says only «субагент работает…», while the wave line says which
 * task it is, how long it has run and what it cost.
 */
export function coveredToolUseIds(runs: Record<string, SubagentRun>): Set<string> {
  const out = new Set<string>()
  for (const r of Object.values(runs)) if (r.toolUseId) out.add(r.toolUseId)
  return out
}import { t } from '@/lib/i18n'

