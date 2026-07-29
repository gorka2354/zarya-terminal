import { describe, expect, it } from 'vitest'
import { rewindPoint, type RewindState } from '@shared/rewind'

/**
 * Esc над ОТПРАВЛЕННЫМ сообщением убирает его не только с глаз, но и из памяти
 * агента. Единственный способ это сделать — продолжить беседу от ответа агента
 * (`resumeSessionAt` + `forkSession`), поэтому вся отмена упирается в вопрос
 * «есть ли точка, от которой продолжать». Здесь проверяется именно этот разбор:
 * ошибка в нём либо теряет беседу, либо тихо возвращает отменённое в контекст —
 * а последнее и есть то враньё, ради устранения которого всё затевалось.
 */
const state = (over: Partial<RewindState> = {}): RewindState => ({ resumed: false, ...over })

describe('rewindPoint', () => {
  it('агент уже отвечал → ветка от его последнего ответа', () => {
    expect(rewindPoint(state({ lastAssistantUuid: 'u1', sessionId: 's1' }))).toEqual({
      kind: 'fork',
      sessionId: 's1',
      at: 'u1'
    })
  })

  it('ответ есть, а id сессии ещё нет → отматывать не к чему', () => {
    // init не пришёл: UUID сам по себе бесполезен, resume нужен обязательно.
    expect(rewindPoint(state({ lastAssistantUuid: 'u1' }))).toEqual({ kind: 'fresh' })
  })

  it('чистая сессия без единого ответа → следующий ход начинает с нуля', () => {
    expect(rewindPoint(state({ sessionId: 's1' }))).toEqual({ kind: 'fresh' })
  })

  it('два Esc подряд отматывают к одной и той же точке', () => {
    // Первый Esc увёл беседу веткой от s0/u0; агент в новой ветке сказать ещё
    // ничего не успел. Второй Esc обязан вернуться туда же, а не «в никуда».
    const s = state({ sessionId: 's1', forkBase: { sessionId: 's0', at: 'u0' }, resumed: true })
    expect(rewindPoint(s)).toEqual({ kind: 'fork', sessionId: 's0', at: 'u0' })
  })

  it('свежий ответ агента перебивает точку старой ветки', () => {
    const s = state({
      lastAssistantUuid: 'u9',
      sessionId: 's1',
      forkBase: { sessionId: 's0', at: 'u0' },
      resumed: true
    })
    expect(rewindPoint(s)).toEqual({ kind: 'fork', sessionId: 's1', at: 'u9' })
  })

  it('продолженная сессия без ответа в этом процессе → честный отказ', () => {
    // История есть (беседу подняли с диска), а UUID ответа мы не знаем: начать с
    // нуля — потерять её, продолжить молча — вернуть отменённое в контекст.
    expect(rewindPoint(state({ sessionId: 's1', resumed: true }))).toBeNull()
  })
})
