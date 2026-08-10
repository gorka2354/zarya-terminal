/**
 * Разговор, который можно унести (inc-26).
 *
 * Главное требование к стенограмме — она не врёт о разговоре: в файле ровно то,
 * что было в ленте, включая вызовы инструментов и служебные отметки.
 */
import { describe, it, expect } from 'vitest'
import { toMarkdown, transcriptFileName } from '../src/shared/transcript'
import type { AiMessage } from '../src/shared/types'

const msg = (role: 'user' | 'assistant', content: AiMessage['content']): AiMessage =>
  ({ role, content }) as AiMessage

describe('toMarkdown', () => {
  it('роли подписаны словом — в файле цвета нет', () => {
    const md = toMarkdown([
      msg('user', [{ type: 'text', text: 'почини сборку' }]),
      msg('assistant', [{ type: 'text', text: 'Готово.' }])
    ])
    expect(md).toMatch(/## Человек[\s\S]*почини сборку/)
    expect(md).toMatch(/## Агент[\s\S]*Готово\./)
  })

  it('вызовы инструментов попадают в стенограмму с предметом вызова', () => {
    const md = toMarkdown([
      msg('assistant', [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }
      ])
    ])
    expect(md).toMatch(/`Bash`/)
    expect(md).toMatch(/npm run build/)
  })

  it('служебные отметки не теряются', () => {
    const md = toMarkdown([
      msg('assistant', [
        { type: 'notice', level: 'warn', text: 'API ответил 503' },
        { type: 'reset' },
        { type: 'turn', endReason: 'Ход остановлен: шаги кончились', isError: true }
      ])
    ])
    expect(md).toMatch(/503/)
    expect(md).toMatch(/забыл разговор/)
    expect(md).toMatch(/шаги кончились/)
  })

  it('рассуждение сохраняется, но свёрнутым — ответ важнее', () => {
    const md = toMarkdown([
      msg('assistant', [
        { type: 'thinking', text: 'сначала проверю сборку' },
        { type: 'text', text: 'Готово.' }
      ])
    ])
    expect(md).toMatch(/сначала проверю сборку/)
    expect(md).toMatch(/<details>/)
  })


  it('картинка от инструмента отмечена, но в файл не переносится', () => {
    const md = toMarkdown([
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'Screenshot', input: {} }]),
      msg('user', [
        { type: 'tool_result', toolUseId: 't1', content: 'снято', images: 2 }
      ])
    ])
    expect(md).toMatch(/картинок от инструмента: 2/)
    // Байтов в стенограмме быть не должно ни при каких обстоятельствах.
    expect(md).not.toMatch(/base64|data:/)
  })

  it('обычный итог инструмента формат выгрузки не меняет', () => {
    const md = toMarkdown([
      msg('user', [{ type: 'tool_result', toolUseId: 't1', content: 'exit 0' }])
    ])
    expect(md).not.toMatch(/exit 0/)
  })

  it('пустые сообщения не рождают пустых разделов', () => {
    const md = toMarkdown([msg('assistant', [{ type: 'text', text: '   ' }])])
    expect(md).not.toMatch(/## Агент/)
  })

  it('шапка называет движок и папку, когда они известны', () => {
    const md = toMarkdown([msg('user', [{ type: 'text', text: 'привет' }])], {
      title: 'Разбор сборки',
      engine: 'claude-code',
      cwd: 'C:/code/zarya',
      at: '10.08.2026'
    })
    expect(md.startsWith('# Разбор сборки')).toBe(true)
    expect(md).toMatch(/claude-code · C:\/code\/zarya · 10\.08\.2026/)
  })
})

describe('transcriptFileName', () => {
  it('берёт заголовок и ставит отметку времени', () => {
    expect(transcriptFileName('Разбор сборки', '2026-08-10-14-30')).toBe(
      'Разбор сборки — 2026-08-10-14-30.md'
    )
  })

  it('выкидывает знаки, запрещённые в имени файла', () => {
    const name = transcriptFileName('что: "это"/такое?', '2026-08-10')
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('без заголовка имя всё равно осмысленное', () => {
    expect(transcriptFileName(undefined, '2026-08-10')).toBe('разговор — 2026-08-10.md')
  })
})
