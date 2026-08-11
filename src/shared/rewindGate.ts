import type { AiMessage } from './types'

/**
 * Показывать ли у этого хода кнопку отката файлов.
 *
 * Правило собрано из четырёх запретов, и каждый оплачен находкой ревью:
 *
 * 1. НЕТ ТОЧКИ — НЕТ КНОПКИ. Откат работает по id хода; без него кнопка вела бы
 *    в никуда либо, что хуже, к соседнему ходу.
 * 2. НЕТ КОПИЙ У ЭТОЙ СЕССИИ — НЕТ КНОПКИ. Настройку могли включить уже после
 *    старта сессии: она отвечает на «чего мы хотим», а не на «что есть».
 * 3. ДВИЖОК ТАК НЕ УМЕЕТ — НЕТ КНОПКИ. Кнопка отката там, где откатывать
 *    нечем, — самая дорогая из возможных: на неё рассчитывают.
 * 4. ВЫШЕ ЧЕРТЫ `/clear` ИЛИ СЖАТИЯ — НЕТ КНОПКИ. Движок этих ходов больше не
 *    знает: в лучшем случае человек получит отказ и вопрос «почему она вообще
 *    была», в худшем — откат к состоянию другой ветки разговора.
 */
export function canRewindTurn(o: {
  messages: Array<AiMessage & { turnId?: string }>
  index: number
  checkpointing?: boolean
  engineCan?: boolean
}): boolean {
  const m = o.messages[o.index]
  if (!m || m.role !== 'user' || !m.turnId) return false
  if (!o.checkpointing || !o.engineCan) return false
  return o.index > lastResetIndex(o.messages)
}

/** Где в ленте последняя черта, за которой у движка своя память. */
export function lastResetIndex(messages: AiMessage[]): number {
  let at = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].content.some((p) => p.type === 'reset' || p.type === 'compact')) at = i
  }
  return at
}
