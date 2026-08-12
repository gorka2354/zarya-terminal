import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentFileMap, compareNote } from '../src/main/agentFileMap'
import { fileHash } from '../src/main/rewindFacts'

/**
 * Это единственное место, которое отличает «файл вернётся к прежнему виду» от
 * «ты потеряешь свою правку». Родной откат движка такую разницу не показывает
 * вовсе — проверено прогоном, где ручная строка исчезла молча. Работаем с
 * настоящими файлами: вопрос ровно про то, что лежит на диске.
 */
const root = mkdtempSync(join(tmpdir(), 'zarya-map-'))
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* временная папка */
  }
})

const write = (name: string, text: string): string => {
  const p = join(root, name)
  writeFileSync(p, text)
  return p
}

describe('AgentFileMap', () => {
  it('файл в том виде, в каком его оставил агент, — спокойный', async () => {
    const m = new AgentFileMap()
    const p = write('calm.ts', 'agent wrote this')
    await m.noteAfter('c1', p, 1)
    expect(compareNote(m.note('c1', p), await fileHash(p))).toEqual({
      observed: true,
      changedAfterAgent: false
    })
  })

  it('правка поверх агента видна — и это главный случай инкремента', async () => {
    const m = new AgentFileMap()
    const p = write('mine.ts', 'agent wrote this')
    await m.noteAfter('c1', p, 1)
    writeFileSync(p, 'agent wrote this\nHUMAN EDIT')
    expect(compareNote(m.note('c1', p), await fileHash(p)).changedAfterAgent).toBe(true)
  })

  it('файл переписан байт-в-байт тем же содержимым — тревоги нет', async () => {
    // Ложная тревога приучает жать «дальше» не глядя. Хук вроде prettier может
    // переписать файл, ничего в нём не изменив, — это не повод пугать.
    const m = new AgentFileMap()
    const p = write('same.ts', 'exactly the same')
    await m.noteAfter('c1', p, 1)
    writeFileSync(p, 'exactly the same')
    expect(compareNote(m.note('c1', p), await fileHash(p)).changedAfterAgent).toBe(false)
  })

  it('правка МЕЖДУ двумя правками агента остаётся спорной до конца беседы', async () => {
    // Рефакторинг — это десяток правок одного файла подряд. Без липкого флага
    // второй Edit затирает наше знание, и откат снёс бы дописанное молча.
    const m = new AgentFileMap()
    const p = write('between.ts', 'v1 by agent')
    await m.noteAfter('c1', p, 1)
    writeFileSync(p, 'v1 by agent + human line')
    await m.noteBefore('c1', p)
    writeFileSync(p, 'v2 by agent')
    await m.noteAfter('c1', p, 2)
    const cmp = compareNote(m.note('c1', p), await fileHash(p))
    expect(cmp.changedAfterAgent).toBe(true)
  })

  it('файл есть, но прочитать не смогли — это НЕ «вернётся к прежнему виду»', async () => {
    // Занят другой программой, нет прав, ссылка. Сказать «вернётся» значит
    // обещать за содержимое, которого мы не видели: пусть будет «не ручаемся»,
    // и файл попадёт в страховочную копию.
    const m = new AgentFileMap()
    const p = write('locked.ts', 'agent wrote')
    await m.noteAfter('c1', p, 1)
    expect(compareNote(m.note('c1', p), undefined, true)).toEqual({
      observed: false,
      changedAfterAgent: false
    })
    // А вот отсутствие файла — известное состояние: его вернут, и это спокойно.
    expect(compareNote(m.note('c1', p), undefined, false)).toEqual({
      observed: true,
      changedAfterAgent: false
    })
  })

  it('о файле, которого мы не видели, честно говорим «не знаем»', async () => {
    const m = new AgentFileMap()
    expect(compareNote(m.note('c1', join(root, 'never.ts')), 'abc')).toEqual({
      observed: false,
      changedAfterAgent: false
    })
  })

  it('карта переживает перезапуск: сохранили и подняли', async () => {
    const m = new AgentFileMap()
    const p = write('persist.ts', 'agent wrote')
    await m.noteAfter('c1', p, 3)
    const dumped = m.dump('c1')

    const fresh = new AgentFileMap()
    fresh.load('c1', dumped)
    writeFileSync(p, 'human changed it overnight')
    // Ровно тот сценарий, ради которого карта пишется на диск: вечером правил
    // агент, ночью человек, утром открыли Зарю — и карточка обязана знать.
    expect(compareNote(fresh.note('c1', p), await fileHash(p)).changedAfterAgent).toBe(true)
  })

  it('карта закрытой беседы забывается', async () => {
    const m = new AgentFileMap()
    const p = write('gone.ts', 'x')
    await m.noteAfter('c1', p, 1)
    m.forget('c1')
    expect(m.note('c1', p)).toBeUndefined()
  })
})
