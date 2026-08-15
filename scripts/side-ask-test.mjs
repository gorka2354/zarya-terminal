/**
 * Боковой вопрос: честность обещания там, где оно НЕ сбывается (inc-43).
 *
 *   node scripts/side-ask-test.mjs
 *
 * Само обещание («агент этого не вспомнит») проверяет живой прогон — доказать
 * его можно только чужой памятью. Здесь проверяется обратный случай, который
 * важнее для доверия: движок форка НЕ УМЕЕТ. Тогда кнопки не должно быть вовсе,
 * а если вопрос всё же ушёл — пометка обязана сказать, что он остался в
 * контексте. Молча нарисовать «мимо контекста» здесь было бы худшим исходом.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '') }
}
const note = (...a) => console.log('   ·', ...a)

const ud = mkdtempSync(join(tmpdir(), 'zarya-side-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const conv = (page, id) => page.evaluate((x) => window.__zaryaConvById?.(x), id)
const waitIdle = async (page, id, ms = 30000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const c = await conv(page, id)
    if (c && c.streaming !== true) return true
    await page.waitForTimeout(200)
  }
  return false
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] У движка без форка кнопки НЕТ')
  /*
   * Правило то же, что у чипа режима плана: переключателя нет там, где движок
   * так не умеет. Кнопка «спросить мимо контекста» у Codex обещала бы ровно то,
   * чего он не сделает.
   */
  const a = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await waitIdle(page, a)
  await page.evaluate(() => {
    const el = document.querySelector('.zy-agentbar-input')
    if (el) {
      el.value = 'вопрос'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await page.waitForTimeout(500)
  const btn = await page.evaluate(() => document.querySelectorAll('.zy-agentbar-side').length)
  ok('кнопки бокового вопроса у Codex нет', btn === 0, { btn })

  console.log('\n[2] Если вопрос всё же ушёл — пометка НЕ ВРЁТ')
  await page.evaluate((id) => window.__zaryaSendSide?.(id, 'а что такое X?'), a)
  await waitIdle(page, a)
  await page.waitForTimeout(800)
  const c1 = await conv(page, a)
  note('пометки:', JSON.stringify(c1?.sideMarks))
  ok('пометка в ленте появилась', (c1?.sideMarks ?? []).length === 1, c1?.sideMarks)
  ok(
    'и говорит, что обещание НЕ сбылось',
    c1?.sideMarks?.[0] === false,
    c1?.sideMarks
  )
  const mark = await page.evaluate(() => document.querySelector('.zy-mf-side')?.textContent ?? '')
  note('на экране:', JSON.stringify(mark))
  ok('человеку сказано прямо: осталось в контексте', /остал/i.test(mark), mark)
  ok('и это НЕ выдано за успех', !/дальше не поедет/i.test(mark), mark)

  console.log('\n[3] Возвращаться некуда — значит и не возвращаемся')
  ok('точка ветки не выставлена', !c1?.sideBack, c1?.sideBack)
  if (process.env.ZARYA_SHOT) {
    await page.screenshot({ path: process.env.ZARYA_SHOT })
    note('снимок:', process.env.ZARYA_SHOT)
  }
} catch (e) {
  fail++
  console.log('  ✗ ПРОГОН УПАЛ:', e?.message || e)
} finally {
  await app.close().catch(() => {})
  rmSync(ud, { recursive: true, force: true })
}

console.log(`\nИтог: ${pass} прошло, ${fail} упало`)
process.exit(fail ? 1 : 0)
