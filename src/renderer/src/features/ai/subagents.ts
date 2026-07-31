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
    done: ev.phase === 'done' || prev?.done === true
  }
  return { ...runs, [ev.taskId]: next }
}

/** Roll the runs up into the one line the feed shows. */
export function summarizeWave(runs: Record<string, SubagentRun>, now: number): WaveSummary {
  const all = Object.values(runs)
  let tokens = 0
  let elapsed = 0
  const running: SubagentRun[] = []
  for (const r of all) {
    tokens += r.totalTokens ?? 0
    // A finished task keeps the SDK's own duration; a live one is measured from
    // when we first saw it, so the timer ticks between updates instead of
    // freezing on the last reported value.
    const dur = r.done ? (r.durationMs ?? 0) : Math.max(r.durationMs ?? 0, now - r.startedAt)
    if (dur > elapsed) elapsed = dur
    if (!r.done) running.push(r)
  }
  return {
    total: all.length,
    done: all.filter((r) => r.done).length,
    tokens,
    elapsedMs: elapsed,
    running
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

