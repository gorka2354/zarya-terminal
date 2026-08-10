/**
 * Чем кончился ход — словами, а не одним словом «ошибка».
 *
 * Движок называет исход двумя полями: `subtype` итога (`error_max_turns`,
 * `error_max_budget_usd`, …) и `terminal_reason` — почему остановился цикл
 * (`prompt_too_long`, `hook_stopped`, `budget_exhausted`, …). Заря брала из
 * итога только флаг `is_error`, и человек видел «ошибка» одинаково там, где
 * кончились ходы, где упёрлись в потолок трат и где сам движок отказался
 * продолжать. Это три разных решения человека, а не одна новость.
 *
 * Разбор чистой функцией: у неё вход и выход, и её можно проверить построчно, а
 * дожидаться настоящего исчерпания бюджета в прогоне — нельзя.
 */
import { tm } from './lang'

/**
 * Исходы, о которых стоит сказать. `completed` молчит: ход, закончившийся
 * нормально, не нуждается в объяснении, а строка «завершено успешно» под каждым
 * ответом — шум, который перестают читать.
 */
const REASONS = new Set([
  'blocking_limit',
  'rapid_refill_breaker',
  'prompt_too_long',
  'image_error',
  'model_error',
  'api_error',
  'malformed_tool_use_exhausted',
  'aborted_streaming',
  'aborted_tools',
  'stop_hook_prevented',
  'hook_stopped',
  'tool_deferred',
  'max_turns',
  'background_requested',
  'budget_exhausted',
  'structured_output_retry_exhausted',
  'tool_deferred_unavailable',
  'turn_setup_failed'
])

/** Подтипы ошибочного итога — говорят то же, что и часть причин, но грубее. */
const SUBTYPES: Record<string, string> = {
  error_max_turns: 'max_turns',
  error_max_budget_usd: 'budget_exhausted',
  error_max_structured_output_retries: 'structured_output_retry_exhausted'
}

/**
 * Фраза об исходе хода — или пусто, когда сказать нечего.
 *
 * Порядок: сначала `terminal_reason` (он точнее — движок называет им настоящую
 * причину остановки), затем подтип ошибочного итога. Незнакомую причину не
 * переводим и не выдумываем: показываем общее «ход прерван движком», потому что
 * английский токен в русской фразе объясняет не больше, чем его отсутствие.
 */
export function endReasonText(msg: unknown): string {
  const m = (msg ?? {}) as Record<string, unknown>
  const reason = typeof m.terminal_reason === 'string' ? m.terminal_reason : ''
  const subtype = typeof m.subtype === 'string' ? m.subtype : ''
  const key = REASONS.has(reason) ? reason : SUBTYPES[subtype] || ''
  if (key) return tm(`drv.end.${key}`)
  // Ошибочный итог без внятной причины всё равно должен назваться: тишина здесь
  // и есть то самое «просто ошибка».
  if (subtype && subtype !== 'success') return tm('drv.end.unknown')
  return ''
}
