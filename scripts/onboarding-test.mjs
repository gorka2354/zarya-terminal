/**
 * Первый экран — и то, чего он НЕ делает.
 *
 * Знакомство это самая удобная минута, чтобы завести «анонимный идентификатор
 * только для метрик»: человек ещё ничего не настроил и согласится на что
 * угодно. Именно за это мы ругаем соседей, поэтому здесь проверяется не только
 * то, что экран показывается и проходится, но и что он:
 *   — не показывается тем, кто ОБНОВИЛСЯ (у них настройки уже есть);
 *   — закрывается насовсем и не приходит второй раз;
 *   — ничего не устанавливает сам, а даёт команду человеку;
 *   — применяет ответ к настройкам ЭТОГО человека, а не куда-то отправляет.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
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

const launch = (userData) =>
  electron.launch({
    args: [
      join(root, 'out', 'main', 'index.js'),
      // Язык — системной локалью, а НЕ файлом настроек: весь смысл первого
      // экрана в том, что настроек ещё нет, и подкладывать их сюда значило бы
      // проверять другой сценарий. На машине разработчика локаль русская, на
      // ubuntu-раннере английская — без этого флага прогон падал в CI, ловя
      // английские надписи русскими проверками.
      '--lang=ru-RU'
    ],
    env: {
      ...process.env,
      ZARYA_USER_DATA: userData,
      ZARYA_NO_UPDATE_CHECK: '1',
      // Дублируем для systemd-окружения раннера: Chromium читает локаль и
      // отсюда, а app.getLocale() обязан отдать ru в обоих случаях.
      LANG: 'ru_RU.UTF-8',
      LC_ALL: 'ru_RU.UTF-8',
      NODE_ENV: 'production'
    }
  })

const ready = async (app) => {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2600)
  return page
}

// --- первый запуск: профиль пустой, файла настроек нет вовсе ---------------
const fresh = mkdtempSync(join(tmpdir(), 'zarya-ob-'))
let app = await launch(fresh)
try {
  const page = await ready(app)

  console.log('\n[1] На чистой машине здороваются')
  ok('первый экран показан', !!(await page.$('.zy-ob')))
  const first = await page.evaluate(() => ({
    title: document.querySelector('.zy-ob-title')?.textContent ?? '',
    step: document.querySelector('.zy-ob-step')?.textContent ?? '',
    skip: !!document.querySelector('.zy-ob-btn--quiet')
  }))
  ok('сказано, что это вообще такое', /терминал/i.test(first.title), first.title)
  ok('видно, сколько шагов', /1\s*из\s*3/.test(first.step), first.step)
  ok('выход не спрятан', first.skip, first)
  const local = await page.evaluate(
    () => document.querySelector('.zy-ob-body')?.textContent ?? ''
  )
  ok(
    'обещание про машину дано сразу',
    /никуда ничего не отправл/i.test(local),
    local.slice(-90)
  )
  if (shots) await page.screenshot({ path: join(shots, 'onboarding-1.png') })

  console.log('\n[2] Шаг про агентов честен: показывает, а не ставит')
  await page.click('.zy-ob-btn--go')
  await page.waitForTimeout(900)
  const agents = await page.evaluate(() => ({
    text: document.querySelector('.zy-ob-body')?.textContent ?? '',
    cmds: [...document.querySelectorAll('.zy-ob-cmd')].map((e) => e.textContent),
    rows: document.querySelectorAll('.zy-ob-install-row').length,
    found: document.querySelectorAll('.zy-ob-cli--on').length
  }))
  ok('агенты проверены на машине', agents.rows > 0 || agents.found > 0, agents)
  ok(
    'команды установки настоящие, а не выдуманные',
    agents.cmds.every((c) => /^npm install -g @/.test(c ?? '')),
    agents.cmds
  )
  ok('сказано, что Заря ничего не ставит сама', /не устанавливает сама/i.test(agents.text))
  if (shots) await page.screenshot({ path: join(shots, 'onboarding-2.png') })

  console.log('\n[3] Развилка применяется сразу и остаётся у человека')
  await page.click('.zy-ob-btn--go')
  await page.waitForTimeout(700)
  const cards = await page.$$('.zy-ob-card')
  ok('выбор из двух', cards.length === 2, cards.length)
  await cards[1].click()
  await page.waitForTimeout(500)
  const ide = await page.evaluate(() => window.__zaryaSettings?.().ideMode)
  ok('надстройка включилась тут же', ide === true, ide)
  await cards[0].click()
  await page.waitForTimeout(500)
  ok(
    'и выключается тоже сразу',
    (await page.evaluate(() => window.__zaryaSettings?.().ideMode)) === false
  )
  if (shots) await page.screenshot({ path: join(shots, 'onboarding-3.png') })

  console.log('\n[4] «Начать работу» закрывает знакомство')
  await page.click('.zy-ob-btn--go')
  await page.waitForTimeout(800)
  ok('экран закрыт', !(await page.$('.zy-ob')))
  ok(
    'отметка сохранена в НАСТРОЙКАХ, а не отправлена',
    (await page.evaluate(() => window.__zaryaSettings?.().onboarded)) === true
  )
} finally {
  await app.close()
}

// --- второй запуск того же профиля ----------------------------------------
app = await launch(fresh)
try {
  const page = await ready(app)
  console.log('\n[5] Второй раз не здороваются')
  ok('экрана нет', !(await page.$('.zy-ob')))
  const saved = JSON.parse(readFileSync(join(fresh, 'settings.json'), 'utf8'))
  ok('в файле настроек стоит отметка', saved.onboarded === true, saved.onboarded)
} finally {
  await app.close()
}

// --- профиль «человека, который обновился» --------------------------------
const upgraded = mkdtempSync(join(tmpdir(), 'zarya-ob-old-'))
writeFileSync(
  join(upgraded, 'settings.json'),
  // Настройки от прошлой версии: поля `onboarded` в них нет и быть не может.
  JSON.stringify({ appearance: { language: 'ru' }, ideMode: true })
)
app = await launch(upgraded)
try {
  const page = await ready(app)
  console.log('\n[6] Тому, кто обновился, знакомство не показывают')
  ok('экрана нет', !(await page.$('.zy-ob')))
  ok(
    'и его собственные настройки не тронуты',
    (await page.evaluate(() => window.__zaryaSettings?.().ideMode)) === true
  )
  ok('файл настроек на месте', existsSync(join(upgraded, 'settings.json')))
} finally {
  await app.close()
}

console.log(`\n[onboarding] PASS ${pass} · FAIL ${fail}`)
if (fail) process.exit(1)
