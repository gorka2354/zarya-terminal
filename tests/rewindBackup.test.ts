import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Страховочная копия — последнее, что стоит между человеком и потерей работы.
 *
 * У движка есть «до агента», но нет «до отката»: нажал — и ручная правка исчезла
 * без корзины и без reflog. Всё, что здесь проверяется, проверяется ровно потому,
 * что молчаливый провал копии выглядит как успешный откат.
 */
const home = mkdtempSync(join(tmpdir(), 'zarya-backup-ud-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-backup-work-'))

// Модуль живёт в главном процессе и спрашивает у Electron папку профиля.
// Подменяем ровно её: всё остальное — настоящая файловая система, вопрос-то
// именно про то, что окажется на диске.
vi.mock('electron', () => ({ app: { getPath: () => home } }))

const { backupBeforeRewind, backupUsage, cleanupOld, clearBackups, forgetBackups } = await import(
  '../src/main/rewindBackup'
)

const root = join(home, 'rewind-backup')
const file = (name: string, text = 'моя работа') => {
  const p = join(work, name)
  writeFileSync(p, text, 'utf8')
  return p
}

beforeEach(async () => {
  await clearBackups()
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

describe('backupBeforeRewind', () => {
  it('копирует содержимое, а не просто создаёт папку', async () => {
    const p = file('a.txt', 'два часа работы')
    const r = await backupBeforeRewind('conv-1', [p])
    expect(r.saved).toBe(1)
    expect(r.skipped).toEqual([])
    const saved = readdirSync(r.dir!)
    expect(saved).toHaveLength(1)
    expect(readFileSync(join(r.dir!, saved[0]), 'utf8')).toBe('два часа работы')
  })

  it('пустой список — ни папки, ни следа', async () => {
    const r = await backupBeforeRewind('conv-2', [])
    expect(r).toEqual({ saved: 0, skipped: [] })
    expect(existsSync(root)).toBe(false)
  })

  it('исчезнувший файл называется своей причиной, а не «лимитом»', async () => {
    const r = await backupBeforeRewind('conv-3', [join(work, 'нет-такого.txt')])
    expect(r.saved).toBe(0)
    expect(r.skipped).toEqual([{ path: join(work, 'нет-такого.txt'), reason: 'missing' }])
    // Ни одного файла не сохранилось — пустая папка это мусор, её быть не должно.
    expect(r.dir).toBeUndefined()
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it('файлы разных бесед не смешиваются в одной папке', async () => {
    const a = await backupBeforeRewind('conv-A', [file('a2.txt')])
    const b = await backupBeforeRewind('conv-B', [file('b2.txt')])
    expect(a.dir).not.toBe(b.dir)
    await forgetBackups('conv-A')
    expect(existsSync(a.dir!)).toBe(false)
    // Чужая копия при этом на месте: убирать надо своё.
    expect(existsSync(b.dir!)).toBe(true)
  })

  it('id беседы не выводит копии за пределы папки профиля', async () => {
    // Путь, собранный из чужой строки, — то самое место, где `..` однажды
    // удаляет не ту папку. Имя должно остаться внутри rewind-backup.
    const r = await backupBeforeRewind('../../злой', [file('c.txt')])
    expect(r.dir!.startsWith(root)).toBe(true)
    expect(r.dir).not.toContain('..')
  })

  it('счётчик занятого места считает наши копии, а не чужие', async () => {
    await backupBeforeRewind('conv-U', [file('u.txt', 'x'.repeat(100))])
    const u = await backupUsage()
    expect(u.runs).toBe(1)
    expect(u.bytes).toBe(100)
    await clearBackups()
    expect((await backupUsage()).runs).toBe(0)
  })
})

describe('cleanupOld', () => {
  it('свежие копии переживают уборку, просроченные — нет', async () => {
    const старая = await backupBeforeRewind('conv-old', [file('old.txt')], 1_000_000)
    const свежая = await backupBeforeRewind('conv-new', [file('new.txt')], Date.now())
    // Уборка «сегодня»: копия недельной давности уходит, вчерашняя остаётся.
    await cleanupOld(1_000_000 + 8 * 24 * 60 * 60 * 1000)
    expect(existsSync(старая.dir!)).toBe(false)
    expect(existsSync(свежая.dir!)).toBe(true)
  })

  it('пустая папка копий уборку не роняет', async () => {
    await expect(cleanupOld()).resolves.toBeUndefined()
  })
})
