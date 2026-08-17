import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sweepStaleTemps, writeJsonAtomic } from '../src/main/jsonStore'

/**
 * Брошенные временные файлы атомарной записи.
 *
 * ПОВОД — не гипотеза, а находка на рабочем профиле владельца: 48 файлов
 * `settings.json.<pid>.tmp` за три недели, четырнадцать из них с настройками
 * внутри. Атомарная запись создаёт такой файл и переименовывает его в цель;
 * процесс, не доживший до переименования, оставляет его навсегда — имя несёт
 * чужой pid, и больше к нему никто не вернётся.
 *
 * Здесь проверяется обе половины починки: что запись убирает за собой сама и
 * что старт подчищает накопленное, НЕ трогая чужого.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zarya-sweep-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const HOUR = 60 * 60 * 1000
const older = async (file: string, ms: number): Promise<void> => {
  const t = new Date(Date.now() - ms)
  await fs.utimes(file, t, t)
}

describe('sweepStaleTemps — убирает брошенное', () => {
  it('старый временный файл чужого процесса убран', async () => {
    const f = join(dir, 'settings.json.99999.tmp')
    await fs.writeFile(f, '{}')
    await older(f, 2 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(1)
    await expect(fs.stat(f)).rejects.toThrow()
  })

  it('убирает и пустые — их было больше половины', async () => {
    const f = join(dir, 'settings.json.13588.tmp')
    await fs.writeFile(f, '')
    await older(f, 2 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(1)
  })

  it('считает все убранные, а не первый попавшийся', async () => {
    for (const pid of [111, 222, 333]) {
      const f = join(dir, `settings.json.${pid}.tmp`)
      await fs.writeFile(f, '{}')
      await older(f, 2 * HOUR)
    }
    expect(await sweepStaleTemps(dir)).toBe(3)
  })

  it('папки нет — не падаем: первый запуск выглядит так же', async () => {
    expect(await sweepStaleTemps(join(dir, 'нет-такой'))).toBe(0)
  })

  it('ПОДКАТАЛОГ тоже убирается — там лежат снимки сессий', async () => {
    /*
     * Поймано ревью: уборка смотрела только в корень, а снимки сессий пишутся
     * в `sessions/` — туда, куда пишут чаще всего и где лежит скроллбэк с
     * перепиской. Брошенный файл там не убрал бы никто и никогда.
     */
    const sub = join(dir, 'sessions')
    await fs.mkdir(sub)
    const f = join(sub, 'abc.json.4242.tmp')
    await fs.writeFile(f, '{}')
    await older(f, 2 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(1)
    await expect(fs.stat(f)).rejects.toThrow()
  })

  it('в подкаталоге действуют ТЕ ЖЕ правила — свежее и чужое не трогаем', async () => {
    const sub = join(dir, 'sessions')
    await fs.mkdir(sub)
    const fresh = join(sub, 'a.json.4242.tmp')
    const alien = join(sub, 'чужое.tmp')
    const real = join(sub, 'a.json')
    await fs.writeFile(fresh, '{}')
    await fs.writeFile(alien, 'x')
    await fs.writeFile(real, '{}')
    await older(alien, 5 * HOUR)
    await older(real, 5 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(0)
    await expect(fs.stat(fresh)).resolves.toBeTruthy()
    await expect(fs.stat(alien)).resolves.toBeTruthy()
    await expect(fs.stat(real)).resolves.toBeTruthy()
  })

  it('глубже одного уровня не ходим — чужое дерево не наше дело', async () => {
    const deep = join(dir, 'a', 'b')
    await fs.mkdir(deep, { recursive: true })
    const f = join(deep, 'x.json.777.tmp')
    await fs.writeFile(f, '{}')
    await older(f, 5 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(0)
    await expect(fs.stat(f)).resolves.toBeTruthy()
  })
})

describe('sweepStaleTemps — чужого не трогает', () => {
  it('СВЕЖИЙ временный файл остаётся: рядом может писать второй экземпляр', async () => {
    const f = join(dir, 'settings.json.99999.tmp')
    await fs.writeFile(f, '{}')
    expect(await sweepStaleTemps(dir)).toBe(0)
    await expect(fs.stat(f)).resolves.toBeTruthy()
  })

  it('файл СВОЕГО процесса не трогаем никогда — даже старый', async () => {
    const f = join(dir, `settings.json.${process.pid}.tmp`)
    await fs.writeFile(f, '{}')
    await older(f, 5 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(0)
    await expect(fs.stat(f)).resolves.toBeTruthy()
  })

  it('чужие .tmp не нашего вида остаются: решать за них мы не вправе', async () => {
    const alien = join(dir, 'какая-то-программа.tmp')
    await fs.writeFile(alien, 'x')
    await older(alien, 5 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(0)
    await expect(fs.stat(alien)).resolves.toBeTruthy()
  })

  it('настоящие файлы не трогаем', async () => {
    const real = join(dir, 'settings.json')
    await fs.writeFile(real, '{"a":1}')
    await older(real, 5 * HOUR)
    expect(await sweepStaleTemps(dir)).toBe(0)
    expect(await fs.readFile(real, 'utf8')).toBe('{"a":1}')
  })
})

describe('writeJsonAtomic — не оставляет следов', () => {
  it('удачная запись не оставляет временного файла', async () => {
    const target = join(dir, 'settings.json')
    await writeJsonAtomic(target, { a: 1 })
    const left = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))
    expect(left).toEqual([])
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ a: 1 })
  })

  it('НЕУДАЧНАЯ запись тоже: ошибка есть, мусора нет', async () => {
    /*
     * Цель — папка: переименование поверх неё не пройдёт ни на одной системе.
     * Прежде временный файл в этом случае оставался навсегда — именно так и
     * накопились сорок восемь.
     */
    const target = join(dir, 'занято')
    await fs.mkdir(target)
    await expect(writeJsonAtomic(target, { a: 1 })).rejects.toThrow()
    const left = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))
    expect(left).toEqual([])
  })

  it('ошибка пробрасывается — уборка не делает запись удачной', async () => {
    const target = join(dir, 'занято2')
    await fs.mkdir(target)
    let caught: unknown
    await writeJsonAtomic(target, {}).catch((e) => (caught = e))
    expect(caught).toBeTruthy()
  })
})
