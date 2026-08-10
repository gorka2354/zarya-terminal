/**
 * Что накрывает ступень «правки без спроса» (inc-25).
 *
 * Список закрытый намеренно: ошибка в одну сторону — лишний вопрос, в другую —
 * молча выполненная команда оболочки, которую в этом режиме никто не разрешал.
 */
import { describe, it, expect } from 'vitest'
import { isEditTool } from '../src/shared/editTools'

describe('isEditTool', () => {
  it('правки файлов — да', () => {
    for (const n of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch'])
      expect(isEditTool(n), n).toBe(true)
  })

  it('регистр не важен — движки пишут имена по-разному', () => {
    expect(isEditTool('edit')).toBe(true)
    expect(isEditTool('WRITE')).toBe(true)
  })

  it('команды оболочки и сеть — НЕТ', () => {
    // Главный инвариант ступени: «правки молча» не означает «команды молча».
    for (const n of ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent'])
      expect(isEditTool(n), n).toBe(false)
  })

  it('чтение — НЕТ: ему и так не нужен этот режим', () => {
    for (const n of ['Read', 'Glob', 'Grep']) expect(isEditTool(n), n).toBe(false)
  })

  it('инструменты MCP не угадываем даже по имени', () => {
    // `mcp__fs__write_file` выглядит правкой, но что делает чужой сервер — мы
    // не знаем, и молчаливое «да» ему не выдаём.
    expect(isEditTool('mcp__fs__write_file')).toBe(false)
    expect(isEditTool('mcp__github__create_file')).toBe(false)
  })

  it('незнакомое спрашивает', () => {
    expect(isEditTool('SomethingNew')).toBe(false)
    expect(isEditTool('')).toBe(false)
    expect(isEditTool(undefined)).toBe(false)
    expect(isEditTool(null)).toBe(false)
    expect(isEditTool(42)).toBe(false)
  })
})
