/**
 * Стоимость разговора — та, что считает сам движок.
 *
 * ГЛАВНАЯ ОГОВОРКА. На подписке (Claude Max и подобных) эта цифра — расчёт по
 * тарифам API, а не счёт: с подписки деньги за ход не списываются. Показать
 * «$0.42» человеку, который платит фиксированную сумму в месяц, и промолчать об
 * этом — значит соврать о его деньгах. Поэтому в интерфейсе цифра всегда идёт
 * с указанием, чем она является (см. `bar.costHintPlan` / `bar.costHintApi`),
 * а здесь лежит только арифметика и формат.
 */

/** Сложить стоимость хода с накопленной. Мусор не портит сумму. */
export function addCost(total: number | undefined, turn: unknown): number | undefined {
  const had = typeof total === 'number' && total > 0 ? total : 0
  const add = typeof turn === 'number' && turn > 0 && Number.isFinite(turn) ? turn : 0
  const sum = had + add
  return sum > 0 ? sum : undefined
}

/**
 * Деньги словами.
 *
 * Ноль и «не считали» — разные вещи, и оба не показываются вовсе: пустая строка
 * означает «цифры нет». Меньше цента показываем как «<$0.01», а не как «$0.00»:
 * второе читается как «бесплатно», хотя это округление.
 */
export function formatCost(usd: number | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return ''
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (usd < 1000) return `$${usd.toFixed(1)}`
  return `$${Math.round(usd)}`
}
