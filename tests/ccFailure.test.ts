import { describe, expect, it, vi } from 'vitest'

/**
 * Почему движок по умолчанию не пошёл — человек должен понять из одной строки.
 *
 * Разведка 2026-08-19: `claude login` не упоминался в приложении НИГДЕ, при том
 * что для всех остальных движков такая подсказка есть (`drv.codexAuth`,
 * `drv.kimiMissing`, `main.acp.noAuth`). Любая беда выходила общим «Claude Code
 * не запустился: <текст ошибки SDK>» — и первые пятнадцать минут человека
 * заканчивались чужим стеком вместо действия.
 */
vi.mock('electron', () => ({ app: { getPath: () => '.' }, BrowserWindow: class {} }))

const { ccFailure } = await import('../src/main/claudeCodeDriver')

describe('ccFailure — что делать человеку', () => {
  it('невыполненный вход назван входом, и названа команда', () => {
    for (const msg of [
      'Unauthorized',
      'not logged in',
      'Authentication failed (401)',
      'no api key found'
    ]) {
      const out = ccFailure(new Error(msg))
      expect(out, msg).toMatch(/claude login/)
    }
  })

  it('отсутствующий бинарник — это установка, а не вход', () => {
    for (const msg of ['spawn claude ENOENT', 'claude: command not found']) {
      const out = ccFailure(new Error(msg))
      expect(out, msg).toMatch(/@anthropic-ai\/claude-code/)
      expect(out, msg).not.toMatch(/claude login/)
    }
  })

  it('всё остальное отдаётся ДОСЛОВНО', () => {
    /*
     * Догадка поверх чужой ошибки — это ещё одна ошибка, только с нашей
     * подписью. Незнакомую причину показываем как есть: по ней хотя бы можно
     * искать.
     */
    const out = ccFailure(new Error('socket hang up while streaming'))
    expect(out).toContain('socket hang up while streaming')
    expect(out).not.toMatch(/claude login/)
  })

  it('не-ошибка тоже не теряется', () => {
    expect(ccFailure('странное')).toContain('странное')
    expect(ccFailure(undefined)).toBeTruthy()
  })
})
