import { describe, expect, it } from 'vitest'
import { matchTouched, relativeToRoot, toolPath, touchedSince } from '@shared/touched'
import type { AiContentPart } from '@shared/types'

/**
 * Пометка «этого файла касался агент» стоит рядом с чужой работой человека, и
 * ошибка в ней врёт в обе стороны: лишняя пометка обвиняет агента в правке,
 * которую сделал человек, а пропущенная успокаивает там, где успокаивать
 * нельзя. Поэтому разбор путей проверяется отдельно от интерфейса — живых
 * прогонов с git в CI нет.
 */
const use = (name: string, input: unknown): AiContentPart => ({
  type: 'tool_use',
  id: 't1',
  name,
  input
})
const msg = (role: string, ...content: AiContentPart[]): { role: string; content: AiContentPart[] } => ({
  role,
  content
})

describe('toolPath', () => {
  it('берёт путь у правящих инструментов', () => {
    expect(toolPath('Edit', { file_path: 'C:/p/a.ts' })).toBe('C:/p/a.ts')
    expect(toolPath('Write', { file_path: 'a.ts' })).toBe('a.ts')
    expect(toolPath('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb')
  })

  it('берёт путь и у MCP-инструмента — для карты важен путь, а не доверие', () => {
    // isEditTool специально исключает mcp__*: там решается вопрос допуска.
    // Здесь вопрос другой — что лежит на диске; молчать об этом нельзя.
    expect(toolPath('mcp__fs__write_file', { path: 'C:/p/a.ts' })).toBe('C:/p/a.ts')
  })

  it('читающие инструменты путь не дают: пометка была бы ложным обвинением', () => {
    expect(toolPath('Read', { file_path: 'C:/p/a.ts' })).toBeNull()
    expect(toolPath('Grep', { path: 'C:/p' })).toBeNull()
  })

  it('вызов без пути и мусор на вход — null, а не выдумка', () => {
    expect(toolPath('Bash', { command: 'rm -rf x' })).toBeNull()
    expect(toolPath('Edit', null)).toBeNull()
    expect(toolPath(undefined, { file_path: 'a.ts' })).toBeNull()
    expect(toolPath('Edit', { file_path: '   ' })).toBeNull()
  })
})

describe('touchedSince', () => {
  const conv = [
    msg('user'),
    msg('assistant', use('Edit', { file_path: 'a.ts' })),
    msg('user'),
    msg('assistant', use('Write', { file_path: 'b.ts' }), use('Bash', { command: 'ls' })),
    msg('assistant', use('Edit', { file_path: 'b.ts' }))
  ]

  it('считает с указанного хода и до конца беседы', () => {
    expect(touchedSince(conv, 2).sort()).toEqual(['b.ts'])
    expect(touchedSince(conv, 0).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('повторные правки одного файла не дублируются', () => {
    expect(touchedSince(conv, 3)).toEqual(['b.ts'])
  })

  it('индекс за пределами беседы не ломает разбор', () => {
    expect(touchedSince(conv, 99)).toEqual([])
    expect(touchedSince([], 0)).toEqual([])
  })
})

describe('relativeToRoot', () => {
  it('абсолютный путь внутри репозитория становится относительным', () => {
    expect(relativeToRoot('C:/repo/src/a.ts', 'C:/repo')).toBe('src/a.ts')
  })

  it('обратные слэши и регистр диска на Windows не мешают', () => {
    // Движок отдаёт «C:\repo\src\a.ts», git — «src/a.ts»; без нормализации
    // пометка не встала бы ни на один файл, и панель молча выглядела бы пустой.
    expect(relativeToRoot('C:\\Repo\\src\\a.ts', 'c:/repo')).toBe('src/a.ts')
  })

  it('путь вне репозитория — null, а не подделанный относительный', () => {
    expect(relativeToRoot('C:/other/a.ts', 'C:/repo')).toBeNull()
    // Сосед с общим префиксом имени: C:/repo2 НЕ внутри C:/repo.
    expect(relativeToRoot('C:/repo2/a.ts', 'C:/repo')).toBeNull()
  })

  it('на Linux регистр значим: A.ts и a.ts — разные файлы', () => {
    expect(relativeToRoot('/repo/src/A.ts', '/repo')).toBe('src/A.ts')
    expect(relativeToRoot('/Repo/src/a.ts', '/repo')).toBeNull()
  })

  it('относительный путь достраивается рабочей папкой движка, а не корнем', () => {
    // Иначе «src/a.ts» из панели, открытой в подпапке, совпал бы с чужим
    // файлом того же имени в корне репозитория.
    expect(relativeToRoot('a.ts', 'C:/repo', 'C:/repo/pkg')).toBe('pkg/a.ts')
    expect(relativeToRoot('a.ts', 'C:/repo')).toBe('a.ts')
  })
})

describe('matchTouched', () => {
  const known = ['src/a.ts', 'src/b.ts']

  it('помечает только то, что git и правда показывает', () => {
    const out = matchTouched(['C:/repo/src/a.ts'], 'C:/repo', 'C:/repo', known)
    expect([...out.inRepo]).toEqual(['src/a.ts'])
    expect(out.outside).toEqual([])
  })

  it('файл вне репозитория попадает в отдельный список, а не теряется', () => {
    // Прогон плана показал: агент из одной папки спокойно пишет в чужой проект,
    // и это самое неприятное место — промолчать о нём нельзя.
    const out = matchTouched(['C:/other/proj/x.ts'], 'C:/repo', 'C:/repo', known)
    expect(out.outside).toEqual(['C:/other/proj/x.ts'])
    expect([...out.inRepo]).toEqual([])
  })

  it('файл внутри репозитория, о котором git молчит, не помечается и не считается внешним', () => {
    // Под .gitignore или уже вернулся к состоянию коммита: обещать «агент
    // трогал» в списке, где его нет, некуда, а во «вне репозитория» — неправда.
    const out = matchTouched(['C:/repo/dist/bundle.js'], 'C:/repo', 'C:/repo', known)
    expect([...out.inRepo]).toEqual([])
    expect(out.outside).toEqual([])
  })

  it('файл в НОВОЙ папке помечает саму папку — git схлопывает её в одну строку', () => {
    // Найдено живым прогоном: агент создал src/shared/fake.ts, git показал
    // только `src/`, и пометка «правил агент» пропадала — работа агента
    // выглядела как чья-то чужая.
    const out = matchTouched(['C:/repo/src/shared/fake.ts'], 'C:/repo', 'C:/repo', ['src/'])
    expect([...out.inRepo]).toEqual(['src/'])
    expect(out.outside).toEqual([])
  })

  it('схожее имя папки не ловится по префиксу строки', () => {
    // `src-old/a.ts` не внутри `src/`: сравнение идёт по границе каталога,
    // иначе пометка расползлась бы на соседние папки.
    const out = matchTouched(['C:/repo/src-old/a.ts'], 'C:/repo', 'C:/repo', ['src/'])
    expect([...out.inRepo]).toEqual([])
  })

  it('регистр пути на Windows не мешает совпадению', () => {
    const out = matchTouched(['c:\\REPO\\src\\A.ts'], 'C:/repo', 'C:/repo', ['src/a.ts'])
    expect(out.inRepo.size).toBe(1)
  })
})
