import { describe, expect, it } from 'vitest'
import {
  classifyProtection,
  isProtectionRisky,
  protectionHint,
  protectionLabel
} from '@shared/secretProtection'

/**
 * Интерфейс рисовал один зелёный бейдж «Ключ сохранён» и когда ключ лежит в
 * хранилище ОС, и когда он лежит base64 — то есть открытым текстом. Зелёное
 * читается как «вопрос закрыт», поэтому такой бейдж не просто неточен: он
 * активно успокаивает там, где успокаивать нечем.
 */
const ENC = 'enc:0123456789abcdef'
const B64 = 'b64:c2stdGVzdA=='

describe('classifyProtection', () => {
  it('нет ключа — нечего защищать', () => {
    expect(classifyProtection(undefined, true)).toBe('none')
    expect(classifyProtection('', true)).toBe('none')
  })

  it('хранилище ОС: зашифровано и система это подтверждает', () => {
    expect(classifyProtection(ENC, true)).toBe('os')
    // Windows/macOS: backend не сообщается, и это нормально.
    expect(classifyProtection(ENC, true, undefined)).toBe('os')
    expect(classifyProtection(ENC, true, 'gnome_libsecret')).toBe('os')
    expect(classifyProtection(ENC, true, 'kwallet6')).toBe('os')
  })

  it('Linux basic_text: префикс enc: есть, защиты нет', () => {
    // Главная ловушка пункта: safeStorage «доступен», encryptString отработал,
    // ключ помечен как зашифрованный — а backend не защищает ничего.
    expect(classifyProtection(ENC, true, 'basic_text')).toBe('weak')
    expect(classifyProtection(ENC, true, 'unknown')).toBe('weak')
  })

  it('шифрование стало недоступно — старый enc: уже не гарантия', () => {
    expect(classifyProtection(ENC, false)).toBe('weak')
  })

  it('base64 — это открытый текст, что бы система ни умела сегодня', () => {
    // Ключ УЖЕ лежит на диске в читаемом виде: появление keyring завтра
    // задним числом его не защитит.
    expect(classifyProtection(B64, true)).toBe('plain')
    expect(classifyProtection(B64, true, 'gnome_libsecret')).toBe('plain')
    expect(classifyProtection(B64, false)).toBe('plain')
  })

  it('значение без известного префикса считается незащищённым', () => {
    // Fail-closed: неизвестная форма не должна выглядеть безопасной.
    expect(classifyProtection('sk-живой-ключ', true)).toBe('plain')
  })
})

describe('подача пользователю', () => {
  it('надписи различают три состояния, а не два', () => {
    expect(protectionLabel('os')).toBe('Ключ в хранилище ОС')
    expect(protectionLabel('weak')).toBe('Ключ защищён слабо')
    expect(protectionLabel('plain')).toBe('Ключ открытым текстом')
    expect(protectionLabel('none')).toBe('Ключ не задан')
  })

  it('у каждого рискованного состояния есть объяснение и что делать', () => {
    for (const p of ['weak', 'plain'] as const) {
      const hint = protectionHint(p)
      expect(hint.length).toBeGreaterThan(40)
      // Не просто «небезопасно», а куда идти.
      expect(/keyring|kwallet|secrets\.json|сохран/i.test(hint)).toBe(true)
    }
  })

  it('предупреждаем именно там, где есть о чём', () => {
    expect(isProtectionRisky('weak')).toBe(true)
    expect(isProtectionRisky('plain')).toBe(true)
    expect(isProtectionRisky('os')).toBe(false)
    expect(isProtectionRisky('none')).toBe(false)
  })
})
