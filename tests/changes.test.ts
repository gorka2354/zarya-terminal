import { describe, expect, it } from 'vitest'
import { changeKind, listChanges, summarize } from '@shared/changes'
import type { GitStatus } from '@shared/types'

/**
 * Панель «что изменилось» — единственное место, которое видит последствия
 * команд оболочки: родной откат движка их не трекает вовсе. Значит человек
 * будет принимать по этому списку решения об удалённых и переписанных файлах,
 * и ошибка разбора здесь — не косметика. Проверяется главное: код git не врёт
 * про то, что лежит на диске СЕЙЧАС, и опасное не уезжает вниз списка.
 */
const status = (files: Array<[string, string]>): GitStatus => ({
  root: 'C:/repo',
  branch: 'main',
  ahead: 0,
  behind: 0,
  dirty: files.length,
  files: files.map(([path, s]) => ({ path, status: s }))
})

describe('changeKind', () => {
  it('удаление выигрывает у добавления: `AD` — это файла на диске уже нет', () => {
    // Иначе панель скажет «добавлен» про файл, которого нет, — ровно то враньё,
    // которое эта панель и должна убирать.
    expect(changeKind('AD')).toBe('deleted')
  })

  it('неотслеживаемый и игнорируемый — свой вид, а не «изменён»', () => {
    expect(changeKind('??')).toBe('untracked')
    expect(changeKind('!')).toBe('untracked')
  })

  it('переименование и копия — отдельный вид', () => {
    expect(changeKind('R.')).toBe('renamed')
    expect(changeKind('C.')).toBe('renamed')
  })

  it('обычная правка в рабочем дереве и в индексе — «изменён»', () => {
    expect(changeKind('.M')).toBe('modified')
    expect(changeKind('M.')).toBe('modified')
    expect(changeKind('MM')).toBe('modified')
  })
})

describe('listChanges', () => {
  it('без git и вне репозитория — пустой список, а не выдуманный', () => {
    expect(listChanges(null)).toEqual([])
    expect(listChanges(undefined)).toEqual([])
    expect(listChanges(status([]))).toEqual([])
  })

  it('порядок — по цене ошибки: удаления сверху, сборка снизу', () => {
    const out = listChanges(
      status([
        ['dist/bundle.js', '??'],
        ['src/b.ts', '.M'],
        ['src/a.ts', 'A.'],
        ['src/gone.ts', '.D'],
        ['src/moved.ts', 'R.']
      ])
    )
    expect(out.map((f) => f.path)).toEqual([
      'src/gone.ts',
      'src/moved.ts',
      'src/b.ts',
      'src/a.ts',
      'dist/bundle.js'
    ])
  })

  it('один путь дважды — остаётся более тяжёлый разбор', () => {
    const out = listChanges(status([['src/a.ts', 'A.'], ['src/a.ts', '.D']]))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('deleted')
  })

  it('внутри одного вида — по алфавиту, чтобы список не прыгал между опросами', () => {
    const out = listChanges(status([['src/z.ts', '.M'], ['src/a.ts', '.M']]))
    expect(out.map((f) => f.path)).toEqual(['src/a.ts', 'src/z.ts'])
  })

  it('схлопнутый неотслеживаемый каталог помечен как каталог', () => {
    // git не перечисляет содержимое новой папки без -uall, а отдаёт `dist/`.
    // Панель на этом признаке гасит раскрытие: диффа у каталога не бывает, и
    // каретка обещала бы содержимое, которого нет.
    const out = listChanges(status([['dist/', '??'], ['src/a.ts', '.M']]))
    expect(out.find((f) => f.path === 'dist/')?.dir).toBe(true)
    expect(out.find((f) => f.path === 'src/a.ts')?.dir).toBeUndefined()
    expect(out[out.length - 1].path).toBe('dist/')
  })

  it('обратные слэши приводятся к прямым: на Windows git отдаёт и те и другие', () => {
    expect(listChanges(status([['src\\win\\a.ts', '.M']]))[0].path).toBe('src/win/a.ts')
  })
})

describe('summarize', () => {
  it('считает по видам и всего', () => {
    const out = summarize(
      listChanges(
        status([
          ['a.ts', '.D'],
          ['b.ts', '.M'],
          ['c.ts', '.M'],
          ['d.ts', '??']
        ])
      )
    )
    expect(out).toEqual({ total: 4, deleted: 1, renamed: 0, modified: 2, added: 0, untracked: 1 })
  })
})
