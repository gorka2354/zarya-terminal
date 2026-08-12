import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkpointUsage, fileHistoryDir } from '../src/main/checkpointStore'

/**
 * Число в настройках — про ЧУЖУЮ папку, растущую от нашей галочки.
 *
 * Показать там константу («около 3-10 МБ») значило бы дать обещание, которое мы
 * не контролируем: на машине владельца в этой папке уже 136 МБ. Поэтому число
 * считается по диску, а место, где оно может соврать, — предел обхода — обязано
 * называть себя вслух.
 */
const root = mkdtempSync(join(tmpdir(), 'zarya-cps-'))
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* временная папка */
  }
})

const stand = (name: string, sessions: Record<string, Record<string, number>>): string => {
  const dir = join(root, name)
  for (const [s, files] of Object.entries(sessions)) {
    mkdirSync(join(dir, s), { recursive: true })
    for (const [f, size] of Object.entries(files)) {
      writeFileSync(join(dir, s, f), 'x'.repeat(size))
    }
  }
  return dir
}

describe('fileHistoryDir', () => {
  it('идёт от домашней папки', () => {
    expect(fileHistoryDir({}, '/дом')).toBe(join('/дом', '.claude', 'file-history'))
  })

  it('CLAUDE_CONFIG_DIR перевешивает — иначе покажем ноль там, где гигабайты', () => {
    expect(fileHistoryDir({ CLAUDE_CONFIG_DIR: '/иначе' }, '/дом')).toBe(
      join('/иначе', 'file-history')
    )
  })

  it('пустая переменная — это не переопределение', () => {
    expect(fileHistoryDir({ CLAUDE_CONFIG_DIR: '   ' }, '/дом')).toBe(
      join('/дом', '.claude', 'file-history')
    )
  })
})

describe('checkpointUsage', () => {
  it('считает байты и сессии по настоящему диску', async () => {
    const dir = stand('обычный', {
      'сессия-1': { 'a.ts': 100, 'b.ts': 50 },
      'сессия-2': { 'c.ts': 25 }
    })
    expect(await checkpointUsage(dir)).toEqual({ bytes: 175, sessions: 2 })
  })

  it('папки нет — так и говорим, а не показываем ноль как факт', async () => {
    const r = await checkpointUsage(join(root, 'никогда-не-было'))
    expect(r).toEqual({ bytes: 0, sessions: 0, missing: true })
    // Разница важна: «0 МБ» и «движок ещё ничего не копировал» — разные ответы
    // на вопрос «а можно ли это чистить».
    expect(r.missing).toBe(true)
  })

  it('пустая папка — это ноль, но не «её нет»', async () => {
    const dir = join(root, 'пустая')
    mkdirSync(dir, { recursive: true })
    const r = await checkpointUsage(dir)
    expect(r.bytes).toBe(0)
    expect(r.missing).toBeUndefined()
  })

  it('файл рядом с сессиями считается, но сессией не притворяется', async () => {
    const dir = stand('смешанный', { 'сессия-1': { 'a.ts': 10 } })
    writeFileSync(join(dir, 'заметка.txt'), 'x'.repeat(7))
    const r = await checkpointUsage(dir)
    expect(r.bytes).toBe(17)
    expect(r.sessions).toBe(1)
  })
})
