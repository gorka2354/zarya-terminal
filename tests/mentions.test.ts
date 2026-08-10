/**
 * Упоминание файла через «@» (inc-25).
 *
 * Правила разбора важнее самой подстановки: «@» встречается в обычном тексте
 * (почта, декораторы, ники), и список, вылезающий на каждое такое «@», мешал бы
 * набирать — а именно набор здесь главное занятие.
 */
import { describe, it, expect } from 'vitest'
import { applyMention, mentionQuery } from '../src/shared/mentions'

describe('mentionQuery', () => {
  it('видит упоминание в начале строки и после пробела', () => {
    expect(mentionQuery('@', 1)).toBe('')
    expect(mentionQuery('@src/ma', 7)).toBe('src/ma')
    expect(mentionQuery('посмотри @src/main.ts', 21)).toBe('src/main.ts')
  })

  it('почта и декораторы упоминанием не считаются', () => {
    // Иначе список файлов вылезал бы посреди адреса и перехватывал стрелки.
    expect(mentionQuery('пиши на egor@example.com', 24)).toBeNull()
    expect(mentionQuery('css: @media', 11)).toBe('media')
    expect(mentionQuery('a@b', 3)).toBeNull()
  })

  it('упоминание кончается пробелом', () => {
    expect(mentionQuery('@src/main.ts почему', 19)).toBeNull()
  })

  it('смотрит на КАРЕТКУ, а не на конец строки', () => {
    // Человек вернулся стрелкой в середину и дописывает путь — список должен
    // помогать там, где курсор, а не там, где текст кончается.
    expect(mentionQuery('@src и ещё хвост', 4)).toBe('src')
  })

  it('после переноса строки тоже работает', () => {
    expect(mentionQuery('первая строка\n@src/ap', 21)).toBe('src/ap')
  })
})

describe('applyMention', () => {
  it('подставляет путь и ставит каретку за ним', () => {
    const r = applyMention('@src/ma', 7, 'src/main.ts')
    expect(r.text).toBe('@src/main.ts ')
    expect(r.caret).toBe(r.text.length)
  })

  it('сохраняет то, что было до и после', () => {
    const text = 'посмотри @src/ma и скажи'
    const r = applyMention(text, 16, 'src/main.ts')
    expect(r.text).toBe('посмотри @src/main.ts  и скажи')
    // Каретка — сразу за подставленным путём, а не в конце строки.
    expect(r.text.slice(0, r.caret)).toBe('посмотри @src/main.ts ')
  })

  it('без упоминания под кареткой ничего не трогает', () => {
    const text = 'обычный текст'
    expect(applyMention(text, 5, 'src/main.ts')).toEqual({ text, caret: 5 })
  })
})
