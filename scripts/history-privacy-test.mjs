/**
 * История команд: выключатель, потолок, очистка — и права на файлы.
 *
 * Команды регулярно содержат секреты: токены в переменных окружения, ключи в
 * аргументах curl, пароли в строках подключения. До этого файл рос без
 * ограничений, выключить запись было нельзя, стереть тоже, а создавался он с
 * правами по умолчанию (0644 на Linux — читает любой пользователь машины).
 *
 * Проверяем на настоящих файлах в настоящем профиле, а не на моках.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-hist-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}

const histFile = join(userData, 'history.jsonl')
const secretsFile = join(userData, 'secrets.json')
const lines = () =>
  existsSync(histFile)
    ? readFileSync(histFile, 'utf8').split('\n').filter((l) => l.trim()).length
    : 0
/** Права в восьмеричном виде; на Windows POSIX-биты не значат почти ничего. */
const mode = (f) => (existsSync(f) ? (statSync(f).mode & 0o777).toString(8) : null)

// Файл, созданный «прошлой версией» с открытыми правами — он только
// дописывается и сам никогда не пересоздастся.
writeFileSync(histFile, '', { mode: 0o644 })

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

const addCmds = (page, n, prefix) =>
  page.evaluate(
    async ({ n, prefix }) => {
      for (let i = 0; i < n; i++) {
        await window.zarya.history.add({
          command: `${prefix} ${i}`,
          cwd: 'C:/tmp',
          ts: Date.now(),
          exitCode: 0
        })
      }
    },
    { n, prefix }
  )

const setHistory = (page, patch) =>
  page.evaluate((p) => window.zarya.settings.set({ history: p }), patch)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Запись включена по умолчанию')
  await addCmds(page, 5, 'echo раз')
  await page.waitForTimeout(400)
  ok('команды записались', lines() === 5, lines())

  console.log('\n[2] Права на файлы сужены — включая созданный ранее')
  await page.evaluate(() => window.zarya.settings.setSecret('openai', 'sk-проверка-прав'))
  await page.waitForTimeout(600)
  ok('secrets.json существует', existsSync(secretsFile))
  if (process.platform === 'win32') {
    // На Windows POSIX-биты Node отображает лишь во флаг «только чтение» —
    // проверять их бессмысленно, но и падать не за что.
    console.log('    (Windows: POSIX-права не применимы, режим', mode(secretsFile) + ')')
    ok('файлы на месте и читаются приложением', mode(histFile) !== null)
  } else {
    ok('secrets.json = 600', mode(secretsFile) === '600', mode(secretsFile))
    ok('history.jsonl = 600 (исправлен старый 644)', mode(histFile) === '600', mode(histFile))
  }

  console.log('\n[3] Выключатель прекращает запись немедленно')
  await setHistory(page, { record: false })
  await page.waitForTimeout(500)
  const before = lines()
  await addCmds(page, 5, 'echo после выключения')
  await page.waitForTimeout(500)
  ok('новых записей нет', lines() === before, { before, now: lines() })
  const text = existsSync(histFile) ? readFileSync(histFile, 'utf8') : ''
  ok('и в файле их действительно нет', !text.includes('после выключения'))

  console.log('\n[4] Потолок обрезает файл, а не только память')
  await setHistory(page, { record: true, maxEntries: 10 })
  await page.waitForTimeout(500)
  await addCmds(page, 250, 'echo много')
  await page.waitForTimeout(1500)
  const after = lines()
  // Уплотнение амортизировано: файл не превышает потолок больше чем на 10%,
  // но не чаще раза в 20 дописываний (см. compactSlack). Для потолка 10 это 30.
  const bound = 10 + Math.max(20, Math.ceil(10 * 0.1))
  ok(`файл ужат до потолка (≤${bound}), а не растёт бесконечно`, after <= bound, after)
  ok('последние команды сохранились', readFileSync(histFile, 'utf8').includes('echo много 249'))

  console.log('\n[5] Очистка стирает и диск, и поиск')
  const stats = await page.evaluate(() => window.zarya.history.stats())
  ok('статистика непустая до очистки', stats.entries > 0, stats)
  await page.evaluate(() => window.zarya.history.clear())
  await page.waitForTimeout(600)
  ok('файл пуст', lines() === 0, lines())
  const found = await page.evaluate(() => window.zarya.history.search('echo'))
  ok('поиск ничего не находит', found.length === 0, found.length)
  const after2 = await page.evaluate(() => window.zarya.history.stats())
  ok('статистика обнулилась', after2.entries === 0, after2)

} finally {
  await app.close()
}

/*
 * Находка аудита 2026-08-04: ПЕРВАЯ запись терялась при каждой загрузке.
 *
 * Срез хвоста считал смещение как `indexOf('\n') + (start > 0 ? 1 : 0)`: при
 * чтении с начала файла прибавлялся ноль, и срез шёл ПО первому переводу
 * строки — то есть первая запись выбрасывалась. Уплотнение потом переписывало
 * файл из памяти, и она пропадала с диска насовсем. Файл из одной команды
 * грузился как пустой.
 *
 * Проверяем на ПОДЛОЖЕННОМ файле: своей записью такое не поймать — она
 * добавляется в память, минуя разбор.
 */
{
  console.log('\n[5] Самая старая запись не теряется при загрузке')
  const ud = mkdtempSync(join(tmpdir(), 'zarya-hist1-'))
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({ appearance: { language: 'ru' }, history: { record: true, maxEntries: 100 } })
  )
  writeFileSync(
    join(ud, 'history.jsonl'),
    ['первая-команда-уникальная', 'вторая', 'третья']
      .map((c, i) => JSON.stringify({ command: c, cwd: 'C:/x', at: 1700000000000 + i }))
      .join('\n') + '\n'
  )
  const app5 = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: ud,
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    }
  })
  try {
    const p5 = await app5.firstWindow()
    await p5.waitForLoadState('domcontentloaded')
    await p5.waitForTimeout(2500)
    const found = await p5.evaluate(() =>
      window.zarya.history.search('первая-команда-уникальная')
    )
    ok('самая старая запись видна в поиске', found.length === 1, found.length)
    const st = await p5.evaluate(() => window.zarya.history.stats())
    ok('счётчик считает все три', st.entries === 3, st)
  } finally {
    await app5.close()
  }
}

console.log(`\n[history-privacy] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
