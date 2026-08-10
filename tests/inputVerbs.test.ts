/**
 * Строки, которые исполняет сама Заря (inc-25): «#» в память и «/copy».
 *
 * Правило одно на оба случая: ошибиться здесь значит либо съесть сообщение,
 * которое человек адресовал агенту, либо отправить агенту то, что предназначалось
 * файлу памяти.
 */
import { describe, it, expect } from 'vitest'
import { localVerb, memoryNote } from '../src/shared/inputVerbs'

describe('memoryNote', () => {
  it('строка с решётки — это запись в память', () => {
    expect(memoryNote('# всегда отвечай по-русски')).toBe('всегда отвечай по-русски')
    expect(memoryNote('#без пробела')).toBe('без пробела')
    expect(memoryNote('   # с отступом')).toBe('с отступом')
  })

  it('многострочная запись сохраняется целиком', () => {
    expect(memoryNote('# правило\nи его продолжение')).toBe('правило\nи его продолжение')
  })

  it('решётка посреди строки памятью не считается', () => {
    // Иначе «issue #12» и «цвет #ff0000» уходили бы в файл вместо агента.
    expect(memoryNote('посмотри issue #12')).toBeNull()
    expect(memoryNote('фон #ff0000 не тот')).toBeNull()
  })

  it('пустая решётка — брошенная мысль, а не просьба запомнить', () => {
    expect(memoryNote('#')).toBeNull()
    expect(memoryNote('#   ')).toBeNull()
    expect(memoryNote('')).toBeNull()
  })
})

describe('localVerb', () => {
  it('«/copy» исполняет Заря', () => {
    expect(localVerb('/copy')).toBe('copy')
    expect(localVerb('  /COPY  ')).toBe('copy')
    expect(localVerb('/копировать')).toBe('copy')
  })

  it('всё остальное идёт движку', () => {
    // Перехватывать команды, о которых мы ничего не знаем, нельзя: их список у
    // движка открытый и растёт без нас.
    for (const s of ['/compact', '/review', '/copy файл', 'copy', 'скопируй ответ'])
      expect(localVerb(s), s).toBeNull()
  })
})
