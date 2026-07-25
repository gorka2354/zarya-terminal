import type { Conversation, PendingTool } from './aiStore'

/**
 * Which pending approval gates need a card of their own.
 *
 * SECURITY: the approval card is the whole point of the gate — it is what the
 * user reads before saying yes. Claude Code announces a tool as a `tool_use`
 * block, so its card is rendered inline with the transcript. Codex and the ACP
 * engines (Gemini/Kimi/Qwen) only raise a bare `permission` event, so their
 * gates had NO card anywhere — while the keyboard shortcut still approved the
 * pending tool. That is a blind "yes" to a command the user never saw.
 *
 * Anything not described by a `tool_use` block is returned here so the surface
 * can render it. Settled gates are excluded: they are already executing and
 * their card would duplicate the running tool.
 */
export function orphanGates(conv: Conversation): PendingTool[] {
  const described = new Set<string>()
  for (const m of conv.messages) {
    for (const p of m.content) {
      if (p.type === 'tool_use') described.add(p.id)
    }
  }
  return conv.pendingTools.filter((t) => !t.settled && !described.has(t.id))
}

/**
 * Human label for a gate that has no `tool_use` block to describe it. Prefers
 * the concrete thing being done (command / path) over the tool's internal name,
 * and never returns an empty string — an unlabelled gate would be as blind as
 * no gate at all.
 */
export function gateLabel(t: PendingTool): string {
  const input = t.input as { command?: string; file_path?: string; path?: string } | null
  if (typeof input?.command === 'string' && input.command.trim()) return input.command
  const path =
    typeof input?.file_path === 'string'
      ? input.file_path
      : typeof input?.path === 'string'
        ? input.path
        : ''
  if (path) return `${t.name || 'инструмент'} · ${path}`
  return t.title?.trim() || t.displayName?.trim() || t.name || 'запрос агента'
}
