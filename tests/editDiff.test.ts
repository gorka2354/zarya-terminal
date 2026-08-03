import { describe, expect, it } from 'vitest'
import { editPreview, lineDiff } from '@shared/editDiff'

/**
 * Правка, которую просят одобрить, обязана быть на экране. Здесь проверяется
 * арифметика этого показа — и главное, чего в ней нет: выдуманных номеров строк
 * (вызов приносит фрагмент файла, а не файл, и позиция нам неизвестна).
 */
describe('построчная разница', () => {
  it('видит замену строки', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c'])
  })

  it('видит вставку без удаления', () => {
    const d = lineDiff('a\nc', 'a\nb\nc')
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['b'])
    expect(d.filter((l) => l.kind === 'del')).toHaveLength(0)
  })

  it('хвостовой перевод строки не превращается в пустую строку', () => {
    expect(lineDiff('a\n', 'a\n')).toEqual([{ kind: 'ctx', text: 'a' }])
  })

  it('windows-переводы строк не ломают сравнение', () => {
    expect(lineDiff('a\r\nb', 'a\nb').every((l) => l.kind === 'ctx')).toBe(true)
  })
})

describe('разбор вызова инструмента', () => {
  it('Edit показывает, что убрано и что добавлено', () => {
    const p = editPreview('Edit', {
      file_path: 'src/a.ts',
      old_string: 'const x = 1',
      new_string: 'const x = 2\nconst y = 3'
    })
    expect(p?.kind).toBe('diff')
    expect(p?.path).toBe('src/a.ts')
    expect(p?.removed).toBe(1)
    expect(p?.added).toBe(2)
  })

  it('Write — это запись целиком, а не дифф', () => {
    // Старого текста в вызове нет, и выдумывать сравнение не с чем: показываем
    // то, что будет записано, и называем это записью.
    const p = editPreview('Write', { file_path: 'a.md', content: '# Заголовок\n\nтекст' })
    expect(p?.kind).toBe('write')
    expect(p?.added).toBe(3)
    expect(p?.removed).toBe(0)
    expect(p?.lines.every((l) => l.kind === 'add')).toBe(true)
  })

  it('MultiEdit складывает куски и считает их', () => {
    const p = editPreview('MultiEdit', {
      file_path: 'src/a.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' }
      ]
    })
    expect(p?.chunks).toBe(2)
    expect(p?.added).toBe(2)
    expect(p?.removed).toBe(2)
  })

  it('имя с префиксом движка тоже узнаётся', () => {
    expect(editPreview('mcp__fs__Edit', { old_string: 'a', new_string: 'b' })?.kind).toBe('diff')
    expect(editPreview('edit', { old_string: 'a', new_string: 'b' })?.kind).toBe('diff')
  })

  it('всё, что не правка файла, оставляет карточку прежней', () => {
    expect(editPreview('Bash', { command: 'ls' })).toBeNull()
    expect(editPreview('Read', { file_path: 'a.ts' })).toBeNull()
    expect(editPreview('Edit', {})).toBeNull()
    expect(editPreview('Edit', null)).toBeNull()
  })

  it('огромная правка обрезается и честно помечается', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const p = editPreview('Write', { file_path: 'a.txt', content: big })
    expect(p?.truncated).toBe(true)
    expect(p?.lines.length).toBeLessThan(500)
    // Счётчик остаётся честным: обрезан показ, а не подсчёт.
    expect(p?.added).toBe(500)
  })
})
