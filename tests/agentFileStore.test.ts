import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Карта «что записал агент» переживает перезапуск — или не переживает.
 *
 * Если не переживает, наутро карточка отката говорит «не ручаемся» о файле, про
 * который вчера знала всё, и человек нажимает вслепую. Каждый тест здесь — про
 * один способ потерять эту карту, и каждый способ уже случался.
 */
const home = mkdtempSync(join(tmpdir(), 'zarya-store-ud-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-store-work-'))

vi.mock('electron', () => ({ app: { getPath: () => home } }))

const { AgentFileMap, AgentFileStore } = await import('../src/main/agentFileMap')

const mapFile = join(home, 'agent-files.json')
const onDisk = (): Record<string, { files: Record<string, unknown> }> =>
  existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : {}

/** Настоящий файл: карта хранит отпечатки, а их не из чего взять без диска. */
const file = (name: string, text = 'написано агентом') => {
  const p = join(work, name)
  writeFileSync(p, text, 'utf8')
  return p
}

beforeEach(() => {
  try {
    rmSync(mapFile, { force: true })
  } catch {
    /* нечего убирать */
  }
})

afterAll(() => {
  for (const d of [home, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка */
    }
  }
})

describe('AgentFileStore', () => {
  it('записанное доживает до следующего запуска', async () => {
    const map = new AgentFileMap()
    const store = new AgentFileStore()
    const p = file('a.ts')
    await map.noteAfter('conv-1', p)
    await store.flush(map, 'conv-1')

    // Второй запуск: новые объекты, общий только файл на диске.
    const map2 = new AgentFileMap()
    await new AgentFileStore().restore(map2, 'conv-1')
    expect(map2.note('conv-1', p)?.hash).toBe(map.note('conv-1', p)?.hash)
  })

  it('ход создания файла тоже переживает перезапуск', async () => {
    const map = new AgentFileMap()
    const p = file('созданный.ts')
    await map.noteAfter('conv-2', p, { createdTurnId: 'turn-7' })
    await new AgentFileStore().flush(map, 'conv-2')

    const map2 = new AgentFileMap()
    await new AgentFileStore().restore(map2, 'conv-2')
    // Без этого поля наутро откат сказал бы «вернётся» о файле, который удалит.
    expect(map2.note('conv-2', p)?.createdTurnId).toBe('turn-7')
  })

  it('выход из приложения не затирает карты чужих бесед', async () => {
    // Чужая беседа уже на диске, и в ЭТОМ запуске её никто не читал: кеш пуст.
    writeFileSync(
      mapFile,
      JSON.stringify({ 'conv-чужая': { at: Date.now(), files: { 'x.ts': { hash: 'ч' } } } }),
      'utf8'
    )
    const map = new AgentFileMap()
    const store = new AgentFileStore()
    await map.noteAfter('conv-моя', file('b.ts'))
    store.schedule(map, 'conv-моя')
    store.flushAllSync(map)

    const all = onDisk()
    expect(Object.keys(all).sort()).toEqual(['conv-моя', 'conv-чужая'])
    expect(all['conv-чужая'].files['x.ts']).toEqual({ hash: 'ч' })
  })

  it('синхронная запись на выходе доносит до диска то, что не успела отложенная', async () => {
    const map = new AgentFileMap()
    const store = new AgentFileStore()
    const p = file('c.ts')
    await map.noteAfter('conv-3', p)
    // Таймер отложенной записи ещё не сработал — приложение закрывают сейчас.
    store.schedule(map, 'conv-3')
    expect(onDisk()['conv-3']).toBeUndefined()
    store.flushAllSync(map)
    expect(Object.keys(onDisk()['conv-3'].files)).toHaveLength(1)
  })

  it('удалённая беседа уносит свою карту', async () => {
    const map = new AgentFileMap()
    const store = new AgentFileStore()
    await map.noteAfter('conv-4', file('d.ts'))
    await store.flush(map, 'conv-4')
    await store.forget('conv-4')
    expect(onDisk()['conv-4']).toBeUndefined()
  })

  it('битый файл карты не роняет запуск — начинаем с чистого листа', async () => {
    writeFileSync(mapFile, '{ это не json', 'utf8')
    const map = new AgentFileMap()
    const store = new AgentFileStore()
    await expect(store.restore(map, 'conv-5')).resolves.toBeUndefined()
    await map.noteAfter('conv-5', file('e.ts'))
    store.schedule(map, 'conv-5')
    store.flushAllSync(map)
    expect(onDisk()['conv-5']).toBeDefined()
  })
})
