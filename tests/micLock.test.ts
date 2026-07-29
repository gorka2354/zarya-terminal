import { beforeEach, describe, expect, it } from 'vitest'
import { _resetMicLock, claimMic, micOwner, releaseMic } from '@/features/voice/micLock'

/**
 * Микрофон один на машину. Пока строка ввода была одна, конфликта не
 * существовало — защита от повторного запуска сидела внутри неё. С несколькими
 * панелями строк становится столько же, и каждая проходила бы СВОЮ защиту:
 * четыре записи одной фразы, четыре локальных расшифровки и текст, вставленный в
 * четыре разные строки.
 */
describe('замок микрофона', () => {
  beforeEach(() => _resetMicLock())

  it('первый занял — второй получает отказ', () => {
    expect(claimMic('панель-1')).toBe(true)
    expect(claimMic('панель-2')).toBe(false)
    expect(micOwner()).toBe('панель-1')
  })

  it('повторный захват своей же панелью не ломает владение', () => {
    // Кнопка и горячая клавиша могут сработать почти одновременно.
    expect(claimMic('панель-1')).toBe(true)
    expect(claimMic('панель-1')).toBe(true)
    expect(micOwner()).toBe('панель-1')
  })

  it('отпускает только владелец', () => {
    claimMic('панель-1')
    // Чужой cleanup не должен открывать микрофон остальным: иначе панель, чья
    // запись ещё идёт, потеряет устройство молча.
    releaseMic('панель-2')
    expect(micOwner()).toBe('панель-1')
    releaseMic('панель-1')
    expect(micOwner()).toBeNull()
  })

  it('после освобождения микрофон достаётся следующему', () => {
    claimMic('панель-1')
    releaseMic('панель-1')
    expect(claimMic('панель-2')).toBe(true)
  })

  it('исчезнувшая панель не роняет освобождение', () => {
    claimMic('панель-1')
    releaseMic(null)
    releaseMic(undefined)
    expect(micOwner()).toBe('панель-1')
  })
})
