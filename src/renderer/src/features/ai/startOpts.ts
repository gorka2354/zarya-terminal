import type { AgentPermissionMode, AiSettings } from '@shared/types'

/**
 * The gate half of a native agent's start options.
 *
 * SECURITY: a native gate is weakened by exactly ONE switch — АВТОПИЛОТ, и он
 * принадлежит БЕСЕДЕ, а не окну (inc-17): чип панели показывает и переключает
 * только её. `ai.autoApprove` is
 * the built-in Zarya agent's `run_command` switch and must never reach a driver:
 * it used to be mapped onto `permissionMode: 'acceptEdits'`, a real Claude Agent
 * SDK mode ("auto-accept file edit operations"), so Write/Edit landed below
 * `canUseTool` — outside the app's approval UI — while the chip read «РУЧНОЙ».
 *
 * Kept as a pure function so that invariant is testable: the store itself can't
 * be imported in the node test environment.
 */
export function nativeGateOpts(
  ai: AiSettings,
  convBypass: boolean | undefined,
  convPlan?: boolean
): {
  permissionMode: AgentPermissionMode
  bypass: boolean
} {
  // `ai` остаётся в сигнатуре намеренно: инвариант «autoApprove НИКОГДА не
  // доезжает до драйвера» проверяется тестом именно на этой функции.
  void ai
  /*
   * РЕЖИМ ПЛАНА — единственный, кроме `default`, который сюда допущен, и
   * допущен потому, что он СТРОЖЕ: агент ничего не выполняет вовсе, сперва
   * рассказывает, что собирается делать.
   *
   * Автопилот при этом принудительно снят. Не из осторожности, а по смыслу:
   * «выполняй без спроса» и «не выполняй ничего» — противоположные ответы на
   * один вопрос, и отправить их вместе значит отправить непонятно что.
   * Приоритет у строгого: ошибка в эту сторону стоит лишнего вопроса, в
   * обратную — сделанной работы, которую не просили.
   */
  if (convPlan === true) return { permissionMode: 'plan', bypass: false }
  // Не решено — значит спрашивать. Умолчание всегда в сторону вопроса.
  return { permissionMode: 'default', bypass: convBypass === true }
}
