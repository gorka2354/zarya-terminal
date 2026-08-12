import { describe, expect, it } from 'vitest'
import { canRewindTurn, lastResetIndex } from '@shared/rewindGate'
import type { AiMessage } from '@shared/types'

/**
 * Кнопка отката — обещание. Показать её там, где откатить нельзя (или можно, но
 * не туда), дороже, чем не показать вовсе: человек на неё рассчитывает в самый
 * неудачный момент. Здесь проверяется каждый из четырёх запретов.
 */
const user = (text: string, turnId?: string): AiMessage & { turnId?: string } => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(turnId ? { turnId } : {})
})
const bot = (): AiMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
const reset = (): AiMessage => ({ role: 'assistant', content: [{ type: 'reset' }] })
const compact = (): AiMessage => ({
  role: 'assistant',
  content: [{ type: 'compact', before: 100, after: 20 }]
})

const base = { engineCan: true }

describe('canRewindTurn', () => {
  it('всё сошлось — кнопка есть', () => {
    expect(canRewindTurn({ messages: [user('раз', 'u1')], index: 0, ...base })).toBe(true)
  })

  it('нет точки отката — кнопки нет', () => {
    expect(canRewindTurn({ messages: [user('раз')], index: 0, ...base })).toBe(false)
  })

  it('движок так не умеет — кнопки нет', () => {
    expect(canRewindTurn({ messages: [user('раз', 'u1')], index: 0, engineCan: false })).toBe(false)
  })

  it('беседа поднята с диска: живой сессии нет, а кнопка есть', () => {
    // Наличие точки само доказывает, что копии снимались: движок называет id
    // хода только тогда. Требовать сверх этого «жива ли сессия» значило бы
    // убрать кнопку в самом частом случае — «открыл Зарю утром».
    expect(canRewindTurn({ messages: [user('вчерашний ход', 'u1')], index: 0, ...base })).toBe(true)
  })

  it('ход выше черты /clear — кнопки нет', () => {
    // Движок этих ходов больше не знает: в лучшем случае человек получит отказ
    // и вопрос «почему она вообще была», в худшем — откат к другой ветке.
    const messages = [user('старый', 'u1'), reset(), user('новый', 'u2')]
    expect(canRewindTurn({ messages, index: 0, ...base })).toBe(false)
    expect(canRewindTurn({ messages, index: 2, ...base })).toBe(true)
  })

  it('сжатие контекста — такая же черта', () => {
    const messages = [user('старый', 'u1'), compact(), user('новый', 'u2')]
    expect(canRewindTurn({ messages, index: 0, ...base })).toBe(false)
    expect(canRewindTurn({ messages, index: 2, ...base })).toBe(true)
  })

  it('на ответе агента кнопки не бывает', () => {
    expect(canRewindTurn({ messages: [bot()], index: 0, ...base })).toBe(false)
  })
})

describe('lastResetIndex', () => {
  it('находит последнюю черту, а не первую', () => {
    expect(lastResetIndex([reset(), bot(), compact(), bot()])).toBe(2)
  })

  it('без черт — минус один', () => {
    expect(lastResetIndex([user('раз'), bot()])).toBe(-1)
  })
})
