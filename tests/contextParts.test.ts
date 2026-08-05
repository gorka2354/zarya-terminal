import { describe, expect, it } from 'vitest'
import {
  contextDeferred,
  contextPartKey,
  contextUsed,
  fmtCtxTokens,
  foldContextParts
} from '@shared/contextParts'

/**
 * Вход здесь — НАСТОЯЩИЙ ответ `getContextUsage()` с машины владельца
 * (scripts/context-dump.mjs). Обе ловушки видны только на нём: по типам из
 * `sdk.d.ts` ни остаток, ни отложенное от обычной статьи не отличить.
 */
const REAL = [
  { name: 'System prompt', tokens: 255, color: 'promptBorder' },
  { name: 'System tools', tokens: 14807, color: 'inactive' },
  { name: 'MCP tools (deferred)', tokens: 22544, color: 'inactive', isDeferred: true },
  { name: 'System tools (deferred)', tokens: 14188, color: 'inactive', isDeferred: true },
  { name: 'Memory files', tokens: 7259, color: 'claude' },
  { name: 'Skills', tokens: 5347, color: 'warning' },
  { name: 'Messages', tokens: 7643, color: 'purple_FOR_SUBAGENTS_ONLY' },
  { name: 'Free space', tokens: 964689, color: 'promptBorder' }
]

describe('разбор контекста по статьям', () => {
  it('остаток окна статьёй расхода не считается', () => {
    // 964 689 «свободно» рядом со «скиллы 5 347» читалось бы как самая дорогая
    // статья — то есть ровно наоборот тому, что есть.
    const parts = foldContextParts(REAL)
    expect(parts.some((p) => /free/i.test(p.name))).toBe(false)
  })

  it('крупные сверху — иначе список не отвечает на вопрос «чем занято»', () => {
    const parts = foldContextParts(REAL)
    expect(parts[0].name).toBe('MCP tools')
    expect(parts.map((p) => p.tokens)).toEqual([22544, 14807, 14188, 7643, 7259, 5347, 255])
  })

  it('пометка «deferred» уходит из имени в поле', () => {
    const parts = foldContextParts(REAL)
    const mcp = parts.find((p) => p.name === 'MCP tools')
    expect(mcp?.deferred).toBe(true)
    // Дважды сказать одно и то же — значит занять строку ничем.
    expect(parts.some((p) => /deferred/i.test(p.name))).toBe(false)
    // Две статьи с одинаковой основой различаются флагом, а не сливаются.
    expect(parts.filter((p) => p.name === 'System tools')).toHaveLength(2)
  })

  it('ЗАНЯТО считается без отложенного — и сходится с числом движка', () => {
    // Это главная проверка файла. `totalTokens` живого ответа — 35 311. Сумма
    // ВСЕХ статей даёт 72 043: вдвое больше. Сложив их, мы сказали бы человеку,
    // что окно занято вдвое сильнее, и он выключил бы сервер, который сейчас
    // ничего не стоит.
    const parts = foldContextParts(REAL)
    expect(contextUsed(parts)).toBe(35311)
    expect(contextDeferred(parts)).toBe(36732)
  })

  it('мусор во входе не роняет разбор', () => {
    expect(foldContextParts(undefined)).toEqual([])
    expect(foldContextParts([])).toEqual([])
    expect(
      foldContextParts([
        { name: '', tokens: 10 },
        { name: 'Пусто', tokens: 0 },
        { name: 'Отрицательно', tokens: -5 },
        { name: 'Не число', tokens: '100' }
      ])
    ).toEqual([])
  })
})

describe('имена статей', () => {
  it('известные переводятся', () => {
    expect(contextPartKey('Memory files')).toBe('ctx.part.memory')
    expect(contextPartKey('MCP tools')).toBe('ctx.part.mcp')
    expect(contextPartKey('messages')).toBe('ctx.part.messages')
  })

  it('незнакомое имя остаётся как есть', () => {
    // Список статей у движка может пополниться. Подставить вместо новой строки
    // ближайшую знакомую значило бы назвать расход чужим именем — и человек
    // принял бы решение о том, чего не понял.
    expect(contextPartKey('Something New')).toBeNull()
    expect(contextPartKey('')).toBeNull()
  })
})

describe('числа читаются с одного взгляда', () => {
  it('порядок важнее точности', () => {
    expect(fmtCtxTokens(255)).toBe('255')
    expect(fmtCtxTokens(6264)).toBe('6.3K')
    expect(fmtCtxTokens(1_000_000)).toBe('1.0M')
  })
})
