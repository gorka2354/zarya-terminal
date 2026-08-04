/**
 * Счётчик срабатываний скиллов: диск, перезапуск и предел роста.
 *
 * `skills-panel-test` смотрит на экран одного запуска, а здесь проверяется то,
 * ради чего счётчик вообще существует и чем он опасен:
 *   1. история ПЕРЕЖИВАЕТ перезапуск — иначе «ни разу за N дней» бессмысленно;
 *   2. файл лежит в данных Зари, а не в чужом конфиге, и содержит ТОЛЬКО имена
 *      скиллов со счётчиками — ни запросов, ни ответов, ни путей;
 *   3. «забыть» действительно забывает и начинает период заново;
 *   4. файл не растёт от чужих данных: тысяча имён разом не раздувает его.
 *
 * Профиль временный, агенты фейковые: ни сети, ни настоящего Claude.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-skusage-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)
const usageFile = join(userData, 'skill-usage.json')

const launch = () =>
  electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ZARYA_USER_DATA: userData,
      ZARYA_FAKE_AGENT: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    }
  })

const ready = async (app) => {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  return page
}

console.log('\n[1] Срабатывание доходит до диска')
let app = await launch()
try {
  const page = await ready(app)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'возьми skill'))
  // Запись отложена на полторы секунды: счётчик копится пачкой, а не дёргает
  // диск на каждое срабатывание.
  await page.waitForTimeout(3500)
  ok('файл счётчика создан', existsSync(usageFile))
  const f1 = JSON.parse(readFileSync(usageFile, 'utf8'))
  const day = Object.keys(f1.days ?? {})[0]
  ok('скилл записан с единицей', f1.days?.[day]?.['code-review'] === 1, f1)
  ok('начало наблюдения проставлено', typeof f1.since === 'number' && f1.since > 0, f1.since)

  // Что в файле НЕТ — важнее того, что есть: счётчик не должен превратиться в
  // журнал работы человека.
  const raw = readFileSync(usageFile, 'utf8')
  ok(
    'ни запроса, ни ответа, ни пути внутрь не попало',
    !/возьми|дифф ветки|[A-Za-z]:\\\\|\/home\//.test(raw),
    raw.slice(0, 200)
  )
} finally {
  await app.close()
}

console.log('\n[2] История переживает перезапуск')
app = await launch()
try {
  const page = await ready(app)
  const usage = await page.evaluate(() => window.zarya.agent.skillUsage())
  ok('прошлое срабатывание на месте', usage?.counts?.['code-review'] === 1, usage)
  ok('период — один день, а не тридцать', usage?.observedDays === 1, usage)

  // Второе срабатывание в новом запуске: счётчик должен КОПИТЬСЯ, а не
  // начинаться заново вместе с приложением.
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'возьми skill ещё раз'))
  await page.waitForTimeout(3500)
  const after = await page.evaluate(() => window.zarya.agent.skillUsage())
  ok('счётчик накопился, а не сбросился', after?.counts?.['code-review'] === 2, after)
} finally {
  await app.close()
}

console.log('\n[3] Чужие данные не раздувают файл')
app = await launch()
try {
  const page = await ready(app)
  await page.evaluate(() => {
    // Тысяча имён разом — так себя ведёт не человек, а испорченный вызов.
    const many = Array.from({ length: 1000 }, (_, i) => `junk-${i}`)
    window.zarya.agent.skillUsed(many)
  })
  await page.waitForTimeout(3500)
  const f = JSON.parse(readFileSync(usageFile, 'utf8'))
  const day = Object.keys(f.days).sort().at(-1)
  const names = Object.keys(f.days[day])
  ok('за раз принято не больше полусотни', names.filter((n) => n.startsWith('junk-')).length <= 50, names.length)
  ok('файл остался маленьким', readFileSync(usageFile, 'utf8').length < 8000, readFileSync(usageFile, 'utf8').length)

  console.log('\n[4] «Забыть» действительно забывает')
  await page.evaluate(() => window.zarya.agent.skillUsageClear())
  await page.waitForTimeout(600)
  const cleared = await page.evaluate(() => window.zarya.agent.skillUsage())
  ok('счётчиков не осталось', Object.keys(cleared?.counts ?? {}).length === 0, cleared)
  ok('период начат заново', cleared?.observedDays === 1, cleared)
  const f2 = JSON.parse(readFileSync(usageFile, 'utf8'))
  ok('и на диске тоже пусто', Object.keys(f2.days ?? {}).length === 0, f2)
} finally {
  await app.close()
}

console.log(`\n[skill-usage] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
