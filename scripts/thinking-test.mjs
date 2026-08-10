/**
 * Рассуждение агента видно (inc-27) — на живом окне.
 *
 * Свёрнуто по умолчанию: развёрнутым оно вытеснило бы с экрана сам ответ ради
 * черновика мысли. Разворачивается щелчком — и тогда текст на месте.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-think-'))
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
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'покажи рассуждение'))
  await page.waitForTimeout(2500)

  console.log('\n[1] Рассуждение есть, но свёрнуто')
  const head = await page.evaluate(() => document.querySelector('.zy-mf-think-head')?.textContent ?? '')
  ok('шторка на месте', /рассужд/i.test(head), head)
  ok('число строк названо', /2/.test(head), head)
  const bodyClosed = await page.evaluate(() => !!document.querySelector('.zy-mf-think-body'))
  ok('текст скрыт', bodyClosed === false)
  const answer = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-mf-answer, .zy-mf-md')).map((e) => e.textContent).join(' ')
  )
  ok('ответ агента при этом виден', /сборка падает/.test(answer), answer.slice(0, 120))

  console.log('\n[2] Щелчок разворачивает')
  await page.click('.zy-mf-think-head')
  await page.waitForTimeout(500)
  const body = await page.evaluate(() => document.querySelector('.zy-mf-think-body')?.textContent ?? '')
  ok('рассуждение раскрылось', /проверю сборку/.test(body), body.slice(0, 120))
  ok('обе строки на месте', /посмотрю тесты/.test(body), body.slice(0, 160))
  if (shots) await page.screenshot({ path: join(shots, 'thinking.png') })
} catch (e) {
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  process.exit(fail ? 1 : 0)
}
