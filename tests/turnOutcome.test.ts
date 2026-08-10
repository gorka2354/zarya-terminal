/**
 * Итог хода называет себя (inc-24).
 *
 * Формы взяты из типов SDK: `SDKResultSuccess` / `SDKResultError` и весь набор
 * `TerminalReason`. Дожидаться настоящего исчерпания бюджета в прогоне нельзя —
 * поэтому разбор вынесен чистой функцией и проверяется здесь.
 */
import { describe, it, expect } from 'vitest'
import { endReasonText } from '../src/main/turnOutcome'

describe('endReasonText', () => {
  it('нормальный ход молчит — объяснять нечего', () => {
    expect(
      endReasonText({ type: 'result', subtype: 'success', terminal_reason: 'completed' })
    ).toBe('')
    expect(endReasonText({ type: 'result', subtype: 'success' })).toBe('')
  })

  it('кончились шаги — так и говорит', () => {
    const t = endReasonText({ type: 'result', subtype: 'error_max_turns', terminal_reason: 'max_turns' })
    expect(t).toMatch(/steps|шаг/i)
    expect(t).not.toMatch(/max_turns/)
  })

  it('подтип итога работает и без terminal_reason', () => {
    expect(endReasonText({ type: 'result', subtype: 'error_max_budget_usd' })).toMatch(/cap|потол/i)
  })

  it('потолок трат и лимит подписки — разные новости', () => {
    const budget = endReasonText({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'budget_exhausted' })
    const limit = endReasonText({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'blocking_limit' })
    expect(budget).not.toBe(limit)
    expect(budget).toBeTruthy()
    expect(limit).toBeTruthy()
  })

  it('причина точнее подтипа: берётся terminal_reason', () => {
    // Подтип сказал бы «кончились шаги», причина — «остановил хук». Права причина.
    const t = endReasonText({
      type: 'result',
      subtype: 'error_max_turns',
      terminal_reason: 'hook_stopped'
    })
    expect(t).toMatch(/hook|хук/i)
  })

  it('каждая известная причина имеет свои слова', () => {
    const reasons = [
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
    ]
    for (const r of reasons) {
      const text = endReasonText({ type: 'result', subtype: 'error_during_execution', terminal_reason: r })
      expect(text, r).toBeTruthy()
      // Ключ не должен просочиться на экран вместо перевода.
      expect(text, r).not.toMatch(/drv\.end/)
      expect(text, r).not.toContain(r)
    }
  })

  it('незнакомая причина не тащит английский токен в ленту', () => {
    const t = endReasonText({
      type: 'result',
      subtype: 'error_during_execution',
      terminal_reason: 'brand_new_reason'
    })
    expect(t).toBeTruthy()
    expect(t).not.toContain('brand_new_reason')
  })

  it('мусор на входе не роняет разбор', () => {
    expect(endReasonText(null)).toBe('')
    expect(endReasonText({})).toBe('')
    expect(endReasonText({ subtype: 42, terminal_reason: [] })).toBe('')
  })
})
