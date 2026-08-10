/**
 * Молчание получает голос (inc-23) — кадр и проверка.
 *
 * Три новости, которые движок говорил в пустоту: повтор запроса после ошибки
 * API, отказ инструменту по правилу, упавший хук. Прогон смотрит, что все три
 * дошли до ленты РАЗНЫМИ строками — «ошибка» одним словом на всё это и была тем,
 * от чего уходим.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-notice-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // Движок подменён только для codex/gemini — на них и проверяем: разбор общий,
  // а живой Claude Code в прогоне пришлось бы доводить до настоящей ошибки API.
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'повтор запроса'))
  await page.waitForTimeout(2500)

  const notices = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-mf-notice-text')).map((e) => e.textContent || '')
  )
  console.log('\n[1] Три новости — три строки')
  ok('строк ровно три', notices.length === 3, notices)
  ok('повтор запроса назван кодом и попыткой', /503/.test(notices[0] ?? '') && /2/.test(notices[0] ?? ''), notices[0])
  ok('отказ называет инструмент', /Bash/.test(notices[1] ?? ''), notices[1])
  ok('упавший хук называет себя и причину', /lint/.test(notices[2] ?? '') && /конфиг/.test(notices[2] ?? ''), notices[2])

  if (shots) await page.screenshot({ path: join(shots, 'notices.png') })
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  process.exit(fail ? 1 : 0)
}
