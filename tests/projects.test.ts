import { describe, expect, it } from 'vitest'
import { PROJECTS_MAX, samePath, withProject } from '@shared/projects'

/**
 * Список проектов — то, что человек видит каждый раз, открывая меню папок.
 * Ошибка здесь не падает и не светится: она молча перемешивает проекты или
 * незаметно теряет тот, с которым работали вчера.
 */
describe('withProject', () => {
  it('свежая папка встаёт первой', () => {
    expect(withProject(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('уже известная папка поднимается наверх, а не дублируется', () => {
    // Иначе список зарастал бы копиями одного проекта — по одной на открытие.
    expect(withProject(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(withProject(['a'], 'a')).toEqual(['a'])
  })

  it('потолок отсекает самую давнюю, а не самую свежую', () => {
    const full = Array.from({ length: PROJECTS_MAX }, (_, i) => `p${i}`)
    const next = withProject(full, 'fresh')
    expect(next).toHaveLength(PROJECTS_MAX)
    expect(next[0]).toBe('fresh')
    // Вытесняется хвост — папка, которую не открывали дольше всех.
    expect(next).not.toContain(`p${PROJECTS_MAX - 1}`)
    expect(next).toContain('p0')
  })

  it('пустой путь не попадает в список', () => {
    // Диалог выбора папки может вернуть пустую строку при отмене; пустая строка
    // в списке выглядела бы безымянной строкой-призраком.
    expect(withProject(['a'], '')).toEqual(['a'])
    expect(withProject(['a'], '   ')).toEqual(['a'])
  })

  it('край пути не теряется: путь хранится целиком', () => {
    const long = 'C:\\Users\\pesto\\Desktop\\zarya-terminal'
    expect(withProject([], long)[0]).toBe(long)
  })
})

describe('samePath', () => {
  it('вид слэшей не делает из одной папки две', () => {
    // Диалог выбора отдаёт обратные слэши, оболочка — прямые; на строке они
    // разные, а папка одна, и метка «открыто сейчас» гасла именно из-за этого.
    expect(samePath('C:\\code\\cv', 'C:/code/cv')).toBe(true)
    expect(samePath('C:/code/cv/', 'C:/code/cv')).toBe(true)
  })

  it('на Windows-пути регистр не важен, на остальных — важен', () => {
    expect(samePath('C:/Code/CV', 'c:/code/cv')).toBe(true)
    // Linux: это две разные папки, и слить их значило бы соврать в другую сторону.
    expect(samePath('/home/egor/Code', '/home/egor/code')).toBe(false)
  })

  it('разные папки остаются разными', () => {
    expect(samePath('C:/code/cv', 'C:/code/cv2')).toBe(false)
    expect(samePath('', 'C:/code')).toBe(false)
  })

  it('список не заводит вторую строку на ту же папку', () => {
    expect(withProject(['C:/code/cv'], 'C:\\code\\cv')).toEqual(['C:\\code\\cv'])
  })
})
