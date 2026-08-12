import type { AiMessage } from './types'

/**
 * Точка, к которой можно откатить файлы, — и на каком сообщении она висит.
 *
 * Родной откат движка работает по UUID сообщения ЧЕЛОВЕКА. Движок отдаёт этот
 * UUID отдельным «повторным» сообщением (replay), и нам надо повесить его на
 * тот пузырь в ленте, который его породил. Мимо цели тут промахнуться легко:
 *
 * - в ленте есть СЛУЖЕБНЫЕ сообщения от роли человека (пометка о прерывании,
 *   контекст, приписка) — они не ход, и точки отката у них нет;
 * - у хода с картинкой содержимое приходит не строкой, а массивом блоков;
 * - ход мог быть отменён, а сообщение убрано — тогда вешать некуда, и вешать
 *   «на последнее» значит соврать: откат уедет не туда, куда показывает кнопка.
 *
 * Поэтому правило одно: помечаем ПОСЛЕДНИЙ ход человека, у которого ещё нет
 * своей точки. Не нашли — не помечаем вовсе (кнопки не будет), и это честнее
 * кнопки, которая откатит чужой ход.
 *
 * ЖИЗНЬ ТОЧКИ — от хода до кнопки и обратно:
 *
 *   человек отправил ход
 *        │  (пузырь в ленте уже нарисован)
 *        ▼
 *   движок: replay-сообщение с uuid ──► turn-id ──► attachTurnId
 *        │                                              │
 *        │  (только если сессия шла с копиями)          ▼
 *        │                                    msg.turnId у ЭТОГО пузыря
 *        ▼                                              │
 *   ai-conversations.json ◄──────────────────────────────┘
 *        │  (точка уезжает на диск вместе с беседой)
 *        ▼
 *   перезапуск Зари ──► беседа поднята ──► кнопка есть, сессии нет
 *                                              │
 *                                              ▼
 *                                    аренда сессии по resume
 */

/** Служебные приписки, которые лента показывает как сообщение человека. */
const SERVICE_PREFIXES = ['[Контекст:', '[Context:']

export function isServiceTurn(m: AiMessage): boolean {
  if (m.role !== 'user') return true
  const text = m.content
    .filter((p): p is Extract<AiContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trimStart()
  if (!text) {
    // Ход из одних картинок — законный ход человека («что тут не так?»).
    return !m.content.some((p) => p.type === 'image')
  }
  return SERVICE_PREFIXES.some((p) => text.startsWith(p))
}

type AiContentPart = AiMessage['content'][number]

/**
 * Индекс сообщения, которому принадлежит пришедший UUID, или -1.
 *
 * Берётся последний ход человека БЕЗ уже проставленной точки: движок присылает
 * replay по одному на ход и в том же порядке, а «последний непомеченный» —
 * единственное правило, которое переживает и отменённые ходы, и служебные
 * вставки между ними.
 */
export function turnIdTarget(messages: Array<AiMessage & { turnId?: string }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isServiceTurn(m)) continue
    return m.turnId ? -1 : i
  }
  return -1
}

/** Проставить точку отката, ничего не меняя, если вешать её некуда. */
export function attachTurnId<T extends AiMessage & { turnId?: string }>(
  messages: T[],
  uuid: string
): T[] {
  const at = turnIdTarget(messages)
  if (at < 0 || !uuid) return messages
  const out = messages.slice()
  out[at] = { ...out[at], turnId: uuid }
  return out
}
