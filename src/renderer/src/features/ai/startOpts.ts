import type { AgentPermissionMode, AiSettings } from '@shared/types'

/**
 * The gate half of a native agent's start options.
 *
 * SECURITY: a native gate is weakened by exactly ONE switch — АВТОПИЛОТ
 * (`ai.claudeBypass`), which the bar's chip always displays. `ai.autoApprove` is
 * the built-in Zarya agent's `run_command` switch and must never reach a driver:
 * it used to be mapped onto `permissionMode: 'acceptEdits'`, a real Claude Agent
 * SDK mode ("auto-accept file edit operations"), so Write/Edit landed below
 * `canUseTool` — outside the app's approval UI — while the chip read «РУЧНОЙ».
 *
 * Kept as a pure function so that invariant is testable: the store itself can't
 * be imported in the node test environment.
 */
export function nativeGateOpts(ai: AiSettings): {
  permissionMode: AgentPermissionMode
  bypass: boolean
} {
  return { permissionMode: 'default', bypass: ai.claudeBypass }
}
