import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { diskFacts, fileHash, outsideCwd, verifyRewind } from '../src/main/rewindFacts'

/**
 * Проверки идут по НАСТОЯЩЕЙ файловой системе, а не по моку: весь смысл этого
 * модуля в том, что он видит то, чего не видит движок — junction на Windows
 * (ставится без прав администратора), исчезнувший файл, файл, до которого
 * откат не дошёл. Мок здесь проверял бы наши же представления о диске.
 */
const root = mkdtempSync(join(tmpdir(), 'zarya-facts-'))
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* временная папка — не наша забота */
  }
})

describe('outsideCwd', () => {
  it('файл внутри папки агента внешним не считается', () => {
    expect(outsideCwd(join(root, 'a.ts'), root)).toBe(false)
  })

  it('сосед с общим началом имени — снаружи', () => {
    // C:/project2 НЕ внутри C:/project: наивное сравнение строк объявило бы
    // чужой проект своим и промолчало бы о самом опасном случае.
    expect(outsideCwd(`${root}2/a.ts`, root)).toBe(true)
  })

  it('пустая рабочая папка — сравнивать не с чем, не выдумываем', () => {
    expect(outsideCwd(join(root, 'a.ts'), '')).toBe(false)
  })
})

describe('diskFacts', () => {
  it('видит обычный файл, его размер и отпечаток', async () => {
    const p = join(root, 'plain.ts')
    writeFileSync(p, 'hello')
    const [f] = await diskFacts([p], root)
    expect(f.existsNow).toBe(true)
    expect(f.size).toBe(5)
    expect(f.hash).toBeTruthy()
    expect(f.linkSkipped).toBeUndefined()
  })

  it('исчезнувший файл — это факт, а не ошибка', async () => {
    const [f] = await diskFacts([join(root, 'nope.ts')], root)
    expect(f.existsNow).toBe(false)
  })

  it('junction помечается как путь, который откат пропустит', async () => {
    // Ровно тот случай, о котором движок сообщает ЧИСЛОМ и уже ПОСЛЕ отката.
    // Сказать заранее можно только своим lstat — и только не по ссылке.
    const target = join(root, 'target-dir')
    const link = join(root, 'link-dir')
    mkdirSync(target, { recursive: true })
    try {
      symlinkSync(target, link, 'junction')
    } catch {
      return // на этой машине ссылки запрещены — проверять нечего
    }
    const [f] = await diskFacts([link], root)
    expect(f.existsNow).toBe(true)
    expect(f.linkSkipped).toBe(true)
    // Содержимое у ссылки не читаем: вопрос был про сам путь.
    expect(f.hash).toBeUndefined()
  })

  it('путь вне папки агента помечен', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'zarya-facts-out-'))
    const p = join(outside, 'x.ts')
    writeFileSync(p, 'x')
    const [f] = await diskFacts([p], root)
    expect(f.outsideCwd).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('fileHash', () => {
  it('одинаковое содержимое — одинаковый отпечаток, разное — разный', async () => {
    const a = join(root, 'h1.ts')
    const b = join(root, 'h2.ts')
    writeFileSync(a, 'one')
    writeFileSync(b, 'one')
    expect(await fileHash(a)).toBe(await fileHash(b))
    writeFileSync(b, 'two')
    expect(await fileHash(a)).not.toBe(await fileHash(b))
  })
})

describe('verifyRewind', () => {
  it('файл изменился — откат до него дошёл', async () => {
    const p = join(root, 'v1.ts')
    writeFileSync(p, 'before')
    const before = await diskFacts([p], root)
    writeFileSync(p, 'after')
    const v = await verifyRewind(before, root)
    expect(v.restored).toBe(1)
    expect(v.untouched).toBe(0)
  })

  it('файл остался прежним — это НЕ успех, а отдельное число', async () => {
    // Прогон разведки: движок отвечает canRewind:true, но до части файлов не
    // доходит (пропала резервная копия). Рапорт «откатили всё» после этого —
    // враньё уже ПОСЛЕ необратимого действия.
    const p = join(root, 'v2.ts')
    writeFileSync(p, 'same')
    const before = await diskFacts([p], root)
    const v = await verifyRewind(before, root)
    expect(v.restored).toBe(0)
    expect(v.untouched).toBe(1)
    expect(v.untouchedPaths).toEqual([p])
  })

  it('файл исчез — тоже изменение', async () => {
    const p = join(root, 'v3.ts')
    writeFileSync(p, 'gone soon')
    const before = await diskFacts([p], root)
    rmSync(p)
    expect((await verifyRewind(before, root)).restored).toBe(1)
  })

  it('файла не было и не появилось — откат обещал создать и не создал', async () => {
    const before = await diskFacts([join(root, 'never.ts')], root)
    const v = await verifyRewind(before, root)
    expect(v.untouched).toBe(1)
  })
})
