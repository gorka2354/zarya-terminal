import { describe, expect, it } from 'vitest'
import { attachTurnId, isServiceTurn, turnIdTarget } from '@shared/turnId'
import type { AiMessage } from '@shared/types'

/**
 * Кнопка отката висит на конкретном пузыре и обещает вернуть файлы «к этому
 * месту». Если точку повесить не на тот ход, кнопка соврёт самым дорогим
 * способом: человек нажмёт её, глядя на один ход, а файлы уедут к другому.
 * Поэтому правило привязки проверяется отдельно от интерфейса.
 */
const user = (text: string): AiMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const bot = (text: string): AiMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const withImage = (): AiMessage => ({
  role: 'user',
  content: [{ type: 'image', mediaType: 'image/png', data: 'AA', width: 1, height: 1 }]
})

describe('isServiceTurn', () => {
  it('ответ агента ходом человека не считается', () => {
    expect(isServiceTurn(bot('привет'))).toBe(true)
  })

  it('приписка контекста — служебная, точки отката у неё нет', () => {
    expect(isServiceTurn(user('[Контекст: файл a.ts]'))).toBe(true)
    expect(isServiceTurn(user('[Context: file a.ts]'))).toBe(true)
  })

  it('ход из одних картинок — законный ход человека', () => {
    // «Что тут не так?» со скриншотом: текста нет, а ход есть, и откатывать к
    // нему нужно так же, как к любому другому.
    expect(isServiceTurn(withImage())).toBe(false)
  })

  it('обычный текстовый ход — не служебный', () => {
    expect(isServiceTurn(user('почини сборку'))).toBe(false)
  })
})

describe('turnIdTarget', () => {
  it('целится в последний ход человека', () => {
    const msgs = [user('раз'), bot('ответ'), user('два'), bot('ответ')]
    expect(turnIdTarget(msgs)).toBe(2)
  })

  it('уже помеченный ход второй раз не помечается', () => {
    // Движок присылает по одному replay на ход. Второй UUID на тот же пузырь
    // означал бы, что мы перепутали ходы, — лучше не повесить вовсе.
    const msgs = [{ ...user('раз'), turnId: 'u1' }, bot('ответ')]
    expect(turnIdTarget(msgs)).toBe(-1)
  })

  it('служебные вставки после хода не сбивают прицел', () => {
    const msgs = [user('раз'), user('[Контекст: a.ts]'), bot('ответ')]
    expect(turnIdTarget(msgs)).toBe(0)
  })

  it('ходов человека нет вовсе — вешать некуда', () => {
    expect(turnIdTarget([bot('привет')])).toBe(-1)
    expect(turnIdTarget([])).toBe(-1)
  })
})

describe('attachTurnId', () => {
  it('ставит точку на нужный ход и не трогает остальные', () => {
    const msgs = [user('раз'), bot('ответ'), user('два')]
    const out = attachTurnId(msgs, 'uuid-2')
    expect(out[2]).toMatchObject({ turnId: 'uuid-2' })
    expect(out[0]).not.toHaveProperty('turnId')
    // Массив пересобран, а не изменён на месте: иначе подписка стора не увидит
    // изменения и кнопка появится только при следующей перерисовке.
    expect(out).not.toBe(msgs)
  })

  it('вешать некуда — беседа возвращается как есть', () => {
    const msgs = [bot('привет')]
    expect(attachTurnId(msgs, 'uuid')).toBe(msgs)
  })

  it('пустой uuid игнорируется', () => {
    const msgs = [user('раз')]
    expect(attachTurnId(msgs, '')).toBe(msgs)
  })
})
