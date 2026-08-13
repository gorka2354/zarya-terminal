import { describe, expect, it } from 'vitest'
import { enginePromptAppend } from '@shared/enginePrompt'

/**
 * Приписка к системному промпту движка. Здесь легко испортить чужое: текст
 * человека — то, что он настраивал руками, и потерять его, дописывая своё,
 * значит молча отменить его правило.
 */
describe('enginePromptAppend', () => {
  const свой = 'Отвечай кратко.'

  it('выключено — едет только текст человека', () => {
    expect(enginePromptAppend(свой, false)).toBe(свой)
  })

  it('выключено и текста нет — не едет ничего', () => {
    expect(enginePromptAppend('', false)).toBe('')
    expect(enginePromptAppend('   ', false)).toBe('')
  })

  it('включено, текста нет — едет только наша просьба', () => {
    const out = enginePromptAppend('', true)
    expect(out).toContain('run_in_background')
    expect(out).toContain('BashOutput')
  })

  it('включено с текстом — текст человека НЕ теряется', () => {
    const out = enginePromptAppend(свой, true)
    expect(out).toContain(свой)
    expect(out).toContain('run_in_background')
  })

  it('текст человека идёт ПОСЛЕ нашего: при споре ближе к концу его слово', () => {
    const out = enginePromptAppend(свой, true)
    expect(out.indexOf('run_in_background')).toBeLessThan(out.indexOf(свой))
  })

  it('лишние пробелы человека не превращаются в пустую строку посреди промпта', () => {
    expect(enginePromptAppend('  ', true)).toBe(enginePromptAppend('', true))
  })

  it('просьба говорит и про короткие команды — иначе агент уведёт в фон всё', () => {
    // Без этой оговорки `git status` уходил бы в фон, и агент ждал бы его
    // вывода отдельным вызовом там, где он нужен немедленно.
    expect(enginePromptAppend('', true)).toMatch(/[Ss]hort commands/)
  })
})
