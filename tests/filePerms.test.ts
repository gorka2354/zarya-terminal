import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from '../src/main/jsonStore'
import { DIR_MODE, FILE_MODE, hardenFile } from '../src/main/filePerms'

/**
 * В userData лежат ключи провайдеров, история всех выполненных команд и
 * переписки с агентом. Node создаёт файлы с правами по умолчанию — на Linux это
 * 0644, читать может любой пользователь машины.
 *
 * Проверять это на Windows бессмысленно: NTFS живёт на ACL, а Node отображает в
 * них только флаг «только чтение», и stat всегда показывает 666. Поэтому тест
 * пропускается на win32 — и обязательно исполняется в CI на ubuntu, где смысл и
 * есть. Молча «зеленеть» на Windows он не должен, поэтому пропуск явный.
 */
const posix = process.platform !== 'win32'
const dir = mkdtempSync(join(tmpdir(), 'zarya-perms-'))
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* уборка не критична */
  }
})

describe.skipIf(!posix)('права на файлы приложения (POSIX)', () => {
  it('writeJsonAtomic создаёт файл только для владельца', async () => {
    const f = join(dir, 'settings.json')
    await writeJsonAtomic(f, { a: 1 })
    expect(mode(f)).toBe(FILE_MODE.toString(8))
  })

  it('перезапись чинит файл, созданный прошлой версией с 0644', async () => {
    // Именно этот случай не лечится сам: у существующих файлов права остаются
    // прежними, пока их кто-нибудь не сузит.
    const f = join(dir, 'legacy.json')
    writeFileSync(f, '{}', { mode: 0o644 })
    expect(mode(f)).toBe('644')
    await writeJsonAtomic(f, { b: 2 })
    expect(mode(f)).toBe('600')
  })

  it('каталог создаётся закрытым', async () => {
    const sub = join(dir, 'nested', 'deep')
    await writeJsonAtomic(join(sub, 'x.json'), {})
    expect(mode(sub)).toBe(DIR_MODE.toString(8))
  })

  it('hardenFile сужает права существующего файла', async () => {
    const f = join(dir, 'history.jsonl')
    writeFileSync(f, 'строка\n', { mode: 0o644 })
    await hardenFile(f)
    expect(mode(f)).toBe('600')
  })

  it('hardenFile молчит про отсутствующий файл, а не падает', async () => {
    await expect(hardenFile(join(dir, 'нет-такого'))).resolves.toBeUndefined()
  })

  it('содержимое не пострадало от возни с правами', async () => {
    const f = join(dir, 'payload.json')
    await writeJsonAtomic(f, { ключ: 'значение', вложенное: [1, 2, 3] })
    const { readFileSync } = await import('node:fs')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({
      ключ: 'значение',
      вложенное: [1, 2, 3]
    })
  })
})

// На Windows проверяем лишь то, что запись вообще работает — права там не наши.
describe.skipIf(posix)('запись на Windows', () => {
  it('файл создаётся и читается', async () => {
    const f = join(dir, 'win.json')
    await writeJsonAtomic(f, { ok: true })
    const { readFileSync } = await import('node:fs')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ ok: true })
  })
})
