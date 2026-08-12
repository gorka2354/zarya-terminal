import { describe, expect, it } from 'vitest'
import {
  marksFor,
  noFileList,
  rewindPlan,
  staleAgainst,
  type FileFacts,
  type SeenFile
} from '@shared/rewindPlan'

/**
 * Карточка отката — единственное место, где человек узнаёт, что произойдёт с
 * его файлами ДО того, как это станет необратимым. Каждая проверка здесь
 * соответствует одному способу соврать, и все три главных найдены живыми
 * прогонами настоящего движка: молчаливое затирание ручной правки, выход за
 * пределы папки и удаление файла под словом «вернётся».
 */
const f = (over: Partial<FileFacts> = {}): FileFacts => ({
  path: 'C:/repo/src/a.ts',
  existsNow: true,
  observed: true,
  ...over
})

describe('marksFor', () => {
  it('файл, созданный после хода, БУДЕТ УДАЛЁН — а не «вернётся»', () => {
    // Прогон: агент создал файл на ходу 3, человек дописал в него 400 строк,
    // откат к ходу 2 удаляет файл целиком. Слово «вернётся» тут стоило бы
    // человеку всей его работы.
    expect(marksFor(f({ createdAfterTurn: true }))).toContain('will-delete')
  })

  it('файла нет сейчас — он будет создан заново', () => {
    expect(marksFor(f({ existsNow: false }))).toContain('will-create')
  })

  it('содержимое разошлось с тем, что записал агент — правка пропадёт', () => {
    expect(marksFor(f({ changedAfterAgent: true }))).toContain('edited-after')
  })

  it('своей записи нет — «не ручаемся», и это НЕ спокойное «вернётся»', () => {
    const marks = marksFor(f({ observed: false }))
    expect(marks).toContain('unobserved')
    expect(marks).not.toContain('restore')
  })

  it('«не ручаемся» не ставится там, где мы уже видели расхождение', () => {
    const marks = marksFor(f({ observed: false, changedAfterAgent: true }))
    expect(marks).toContain('edited-after')
    expect(marks).not.toContain('unobserved')
  })

  it('файл может нести несколько признаков сразу', () => {
    // Тот самый случай, ради которого отказались от групп: файл в чужом
    // проекте, который человек правил вчера. Группа показала бы только «вне
    // папки», и человек согласился бы, не узнав о потере правки.
    const marks = marksFor(f({ outsideCwd: true, changedAfterAgent: true }))
    expect(marks).toEqual(expect.arrayContaining(['outside', 'edited-after']))
  })

  it('спокойное «вернётся» — только когда сказать больше нечего', () => {
    expect(marksFor(f())).toEqual(['restore'])
  })

  it('ссылку движок пропустит — говорим об этом заранее', () => {
    expect(marksFor(f({ linkSkipped: true }))).toContain('skip-link')
  })

  it('несохранённая вкладка редактора — отдельный признак', () => {
    expect(marksFor(f({ dirtyInEditor: true }))).toContain('dirty-editor')
  })
})

describe('rewindPlan', () => {
  const facts: FileFacts[] = [
    f({ path: 'C:/repo/calm.ts' }),
    f({ path: 'C:/repo/new.ts', createdAfterTurn: true }),
    f({ path: 'C:/repo/mine.ts', changedAfterAgent: true }),
    f({ path: 'C:/other/x.ts', outsideCwd: true, observed: false })
  ]

  it('опасное стоит выше спокойного', () => {
    const { rows } = rewindPlan(facts)
    expect(rows[0].path).toBe('C:/repo/mine.ts')
    expect(rows[rows.length - 1].path).toBe('C:/repo/calm.ts')
  })

  it('считает сводку по каждому признаку', () => {
    const { summary } = rewindPlan(facts)
    expect(summary).toMatchObject({
      total: 4,
      willDelete: 1,
      editedAfter: 1,
      outside: 1,
      unobserved: 1
    })
  })

  it('там, где можно потерять работу, помечает список как тревожный', () => {
    expect(rewindPlan(facts).summary.risky).toBe(true)
  })

  it('спокойный список тревожным не объявляет', () => {
    // Ложная тревога на каждом откате приучает жать «дальше» не глядя — и
    // настоящее предупреждение перестаёт работать.
    const calm = rewindPlan([f({ path: 'C:/repo/a.ts' }), f({ path: 'C:/repo/b.ts' })])
    expect(calm.summary.risky).toBe(false)
  })

  it('файл, который держит соседняя панель, назван поимённо', () => {
    const { rows } = rewindPlan([f({ heldByPane: 'proj-b · Codex' })])
    expect(rows[0].marks).toContain('neighbor')
    expect(rows[0].pane).toBe('proj-b · Codex')
  })

  it('пустой список файлов не превращается в «ничего не изменится»', () => {
    expect(noFileList([])).toBe(true)
    expect(noFileList(undefined)).toBe(true)
    expect(noFileList(['a.ts'])).toBe(false)
  })
})

/**
 * Между показом карточки и нажатием проходит время: список читают. За эту
 * минуту файл могли сохранить из редактора, дописать соседней панелью или
 * переписать сборкой. Откат по устаревшему списку стирает то, о чём карточка
 * не сказала — формально не соврали, фактически показали снимок, которого уже
 * нет.
 */
describe('staleAgainst', () => {
  const f = (path: string, hash?: string, existsNow = true): SeenFile => ({
    path,
    existsNow,
    ...(hash ? { hash } : {})
  })

  it('ничего не менялось — расхождений нет', () => {
    const seen = [f('a.ts', 'h1'), f('b.ts', 'h2')]
    expect(staleAgainst(seen, seen)).toEqual([])
  })

  it('содержимое изменилось, пока читали', () => {
    expect(staleAgainst([f('a.ts', 'h1')], [f('a.ts', 'h2')])).toEqual(['a.ts'])
  })

  it('файл появился или исчез — тоже другой мир', () => {
    expect(staleAgainst([f('a.ts', 'h1')], [f('a.ts', 'h1', false)])).toEqual(['a.ts'])
    expect(staleAgainst([f('a.ts', undefined, false)], [f('a.ts', 'h1')])).toEqual(['a.ts'])
  })

  it('путь пропал из списка движка — считаем расхождением', () => {
    expect(staleAgainst([f('a.ts', 'h1')], [])).toEqual(['a.ts'])
  })

  it('нечитаемый файл не объявляем изменившимся по незнанию', () => {
    // Ложная тревога дороже пропуска: она приучает жать «дальше» не глядя.
    expect(staleAgainst([f('link.ts')], [f('link.ts')])).toEqual([])
  })
})
