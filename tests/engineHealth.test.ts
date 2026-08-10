import { describe, expect, it } from 'vitest'
import { buildBinaries, parseAuth } from '../src/main/engineHealth'

/**
 * Экран «Движок» отвечает на вопрос «что на самом деле работает». Ошибка здесь
 * не оставляет пустого места, а называет НЕ ТОТ файл — и человек чинит не то,
 * причём с полной уверенностью, потому что так написано на экране.
 *
 * Дождаться в прогоне двух разных `claude` на одной машине или протухшего
 * токена нечем, поэтому обе функции чистые и проверяются здесь.
 */
describe('buildBinaries — выбранный отмечается по ПУТИ, а не по догадке', () => {
  const bundled = { path: '/app/bundled/claude', version: [2, 1, 220] }
  const system = { path: '/home/me/.local/bin/claude', version: [2, 1, 226] }

  it('выбран системный — помечен он, забандленный показан рядом', () => {
    const out = buildBinaries({ path: system.path, reason: 'system-newer' }, { bundled, system })
    expect(out.map((b) => [b.origin, b.chosen])).toEqual([
      ['system', true],
      ['bundled', false]
    ])
    expect(out[0].version).toBe('2.1.226')
    expect(out[1].version).toBe('2.1.220')
  })

  it('выбран забандленный — системный остаётся в списке невыбранным', () => {
    const out = buildBinaries({ path: bundled.path, reason: 'bundled' }, { bundled, system })
    expect(out.find((b) => b.chosen)?.origin).toBe('bundled')
    expect(out.filter((b) => b.chosen)).toHaveLength(1)
  })

  it('путь из переменной окружения — свой род и он же выбран', () => {
    const out = buildBinaries(
      { path: '/opt/claude', reason: 'env' },
      { bundled, system },
      '/opt/claude'
    )
    expect(out[0]).toEqual({ path: '/opt/claude', origin: 'env', chosen: true })
    expect(out.filter((b) => b.chosen)).toHaveLength(1)
  })

  it('Windows: регистр и вид разделителя не мешают узнать свой же путь', () => {
    const win = { path: 'C:\\Users\\Me\\AppData\\Roaming\\npm\\claude.exe', version: [2, 1, 226] }
    const out = buildBinaries(
      { path: 'c:/users/me/appdata/roaming/npm/claude.exe', reason: 'system-newer' },
      { system: win }
    )
    expect(out[0].chosen).toBe(true)
  })

  it('версию узнать не вышло — поле пустое, а не выдуманное', () => {
    const out = buildBinaries(
      { path: '/x/claude', reason: 'bundled' },
      { bundled: { path: '/x/claude' } }
    )
    expect(out[0].version).toBeUndefined()
  })

  it('ничего не выбрано — никто не помечен, и список всё равно виден', () => {
    const out = buildBinaries({ reason: 'sdk-default' }, { bundled, system })
    expect(out).toHaveLength(2)
    expect(out.some((b) => b.chosen)).toBe(false)
  })
})

describe('parseAuth — берём четыре поля из семи', () => {
  const full = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'me@example.test',
    orgId: '5c066195-985c-4fde-9496-003fd38351a4',
    orgName: "me@example.test's Organization",
    subscriptionType: 'max'
  })

  it('читает вход, способ, почту и тариф', () => {
    expect(parseAuth(full)).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      email: 'me@example.test',
      plan: 'max'
    })
  })

  it('идентификатор организации НЕ берётся: экран настроек попадает на скриншоты', () => {
    const parsed = parseAuth(full) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['email', 'loggedIn', 'method', 'plan'])
  })

  it('не вошли — так и говорим, а не молчим', () => {
    expect(parseAuth('{"loggedIn":false}')).toEqual({
      loggedIn: false,
      method: undefined,
      email: undefined,
      plan: undefined
    })
  })

  it('мусор вместо ответа — null, а не выдуманное «вошли»', () => {
    expect(parseAuth('')).toBeNull()
    expect(parseAuth('не json')).toBeNull()
    expect(parseAuth('{}')).toBeNull()
    expect(parseAuth('{"loggedIn":"yes"}')).toBeNull()
    expect(parseAuth('[]')).toBeNull()
  })

  it('пустые строки не выдаются за значения', () => {
    expect(parseAuth('{"loggedIn":true,"email":"  ","authMethod":""}')).toEqual({
      loggedIn: true,
      method: undefined,
      email: undefined,
      plan: undefined
    })
  })
})
