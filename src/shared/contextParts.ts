/**
 * Разбор контекста по статьям — чем именно занято окно.
 *
 * ЗАЧЕМ. Заря показывала одно число: «35 311 из 1 000 000». Оно отвечает на
 * вопрос «много ли», но не на тот, который человек задаёт следом: «а чем?».
 * Движок разбор считает и отдаёт — до сих пор мы его выбрасывали.
 *
 * ДВЕ ЛОВУШКИ, ради которых это отдельный файл с тестами (обе видны только на
 * настоящем ответе движка, см. scripts/context-dump.mjs):
 *
 * 1. `Free space` — не статья расхода, а ОСТАТОК. В списке занятого ей не
 *    место: на настоящей машине это 964 689 токенов, и строка «свободно» рядом
 *    со «скиллы 5 347» читалась бы как самая дорогая статья.
 *
 * 2. `isDeferred` — то, что в контексте НЕ ЛЕЖИТ. Движок держит эти описания
 *    наготове и подгружает по требованию. Сумма всех статей на живой машине
 *    даёт 72 043 при `totalTokens` 35 311 — ровно вдвое больше правды. Сложить
 *    их вместе значило бы сказать человеку, что окно занято вдвое сильнее, чем
 *    оно занято, и он выключил бы сервер, который ничего не стоит.
 *
 * Цвет движка (`color`) здесь не используется вовсе: это не цвет, а имя токена
 * ЕГО темы — `promptBorder`, `inactive`, `claude`, `purple_FOR_SUBAGENTS_ONLY`.
 * В нашем CSS такая строка либо не значит ничего, либо поспорит с темой.
 */

export interface ContextPart {
  /** Имя статьи, как его дал движок (уже без пометки «deferred»). */
  name: string
  tokens: number
  /** Наготове, но в контексте не лежит: подгрузится, если понадобится. */
  deferred?: boolean
}

/** Остаток окна. Не статья расхода — в списке занятого ему не место. */
const FREE = 'free space'

/**
 * Ответ движка → список статей: без остатка, крупные сверху.
 *
 * Пометка `(deferred)` из имени убирается: она уже есть отдельным полем, и
 * дважды говорить одно и то же — значит занимать строку ничем.
 */
export function foldContextParts(
  raw: { name?: unknown; tokens?: unknown; isDeferred?: unknown }[] | undefined
): ContextPart[] {
  if (!Array.isArray(raw)) return []
  const out: ContextPart[] = []
  for (const r of raw) {
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    const tokens = typeof r?.tokens === 'number' && r.tokens > 0 ? r.tokens : 0
    if (!name || !tokens) continue
    if (name.toLowerCase() === FREE) continue
    out.push({
      name: name.replace(/\s*\(deferred\)\s*$/i, '').trim() || name,
      tokens,
      ...(r.isDeferred === true ? { deferred: true } : {})
    })
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

/** Сколько занято ПРЯМО СЕЙЧАС: отложенное не в счёт. */
export function contextUsed(parts: ContextPart[]): number {
  return parts.reduce((n, p) => (p.deferred ? n : n + p.tokens), 0)
}

/** Сколько подгрузится, если понадобится. */
export function contextDeferred(parts: ContextPart[]): number {
  return parts.reduce((n, p) => (p.deferred ? n + p.tokens : n), 0)
}

/**
 * Ключ перевода для известной статьи — или `null`, если имя незнакомое.
 *
 * Незнакомое показывается КАК ЕСТЬ. Список статей у движка может пополниться, и
 * подставить вместо новой строки ближайшую знакомую значило бы назвать расход
 * чужим именем: человек принял бы решение о том, чего не понял.
 */
export function contextPartKey(name: string): string | null {
  switch (name.toLowerCase()) {
    case 'system prompt':
      return 'ctx.part.prompt'
    case 'system tools':
      return 'ctx.part.tools'
    case 'mcp tools':
      return 'ctx.part.mcp'
    case 'memory files':
      return 'ctx.part.memory'
    case 'skills':
      return 'ctx.part.skills'
    case 'messages':
      return 'ctx.part.messages'
    case 'slash commands':
      return 'ctx.part.commands'
    case 'agents':
      return 'ctx.part.agents'
    default:
      return null
  }
}

/** «6 264» → «6.3K»: точные токены здесь не решают, порядок — решает. */
export function fmtCtxTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}
