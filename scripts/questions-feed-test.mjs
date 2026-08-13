/**
 * Ответы на вопросы агента остаются в ленте — ВСЕ.
 *
 *   node scripts/questions-feed-test.mjs
 *
 * Отчёт владельца: «ответил на много вопросов, а показывается только последний
 * — нужно показать всё, что я выбирал». Разговор с агентом уезжает в
 * стенограмму и читается потом как решение: «выбрали TUI-тестер и локальное
 * хранение» — это и есть решение, а не служебный шум. Потерять его молча значит
 * оставить человека без половины собственного выбора.
 *
 * Проверяются оба случая настоящего движка: НЕСКОЛЬКО вопросов в одном вызове и
 * ещё один вызов следом.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
  return !!cond
}
const note = (...a) => console.log('   ·', ...a)
const shots = process.env.ZARYA_SHOTS || ''

const ud = mkdtempSync(join(tmpdir(), 'zarya-q-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-qw-'))
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

/** Ответы в ленте: строки, начинающиеся со стрелки выбора. */
const выбор = (page) =>
  page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    return [...document.querySelectorAll('.zy-mf-userturn, .zy-mf-user')]
      .filter(vis)
      .map((e) => (e.textContent ?? '').trim())
      .filter((t) => t.includes('➤'))
  })

/** Нажать вариант в панели вопросов по подписи. */
const выбрать = (page, label) =>
  page.evaluate((l) => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const b = [...document.querySelectorAll('.zy-cqb-opt')]
      .filter(vis)
      .find((e) => (e.textContent ?? '').includes(l))
    b?.click()
    return !!b
  }, label)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1280, 880)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))

  console.log('\n[1] Агент задал три вопроса одним вызовом')
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'ask много'))
  await page.waitForTimeout(1600)
  const q1 = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    return [...document.querySelectorAll('.zy-cqb')].filter(vis).length > 0
  })
  ok('панель вопросов открылась', q1)
  if (shots) await page.screenshot({ path: join(shots, 'q-1-first.png') })

  console.log('\n[2] Отвечаем на все три')
  for (const [n, label] of ['TUI-тестер', 'Пока локально', 'Сегодня'].entries()) {
    const hit = await выбрать(page, label)
    note('выбрал:', label, hit ? '' : '(кнопка не найдена!)')
    await page.waitForTimeout(700)
    if (n === 0) {
      /*
       * Второй вопрос на экране — прошлый ответ обязан быть виден ЗДЕСЬ.
       *
       * Вопросов в вызове три, показываются по одному, и до этой правки
       * предыдущий выбор исчезал с глаз: человек отвечал на «где хранить», уже
       * не видя, что выбрал в «что строим». Одно решение, а половина его — в
       * памяти человека.
       */
      const done = await page.evaluate(() => {
        const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
        const el = [...document.querySelectorAll('.zy-cqb-done')].filter(vis)[0]
        return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
      })
      note('в панели видно:', JSON.stringify(done))
      ok('прошлый выбор виден в панели вопросов', /TUI-тестер/.test(done), done)
    }
  }
  await page.waitForTimeout(1200)
  const после1 = await выбор(page)
  note('в ленте:', JSON.stringify(после1))
  ok('ответ попал в ленту', после1.length >= 1, после1)
  // Каждый выбор — отдельное решение, и в стенограмме должны остаться все три.
  const первый = после1.join(' ')
  ok('назван первый выбор', /TUI-тестер/.test(первый), первый)
  ok('назван второй выбор', /Пока локально/.test(первый), первый)
  ok('назван третий выбор', /Сегодня/.test(первый), первый)

  console.log('\n[3] Агент спросил ещё раз — прошлый ответ обязан остаться')
  await page.waitForTimeout(1500)
  const hit = await выбрать(page, 'На фейке')
  note('второй вызов, выбрал:', hit ? 'На фейке' : '(кнопка не найдена!)')
  await page.waitForTimeout(1800)
  const после2 = await выбор(page)
  note('в ленте:', JSON.stringify(после2))
  ok('строк с выбором стало две', после2.length >= 2, после2)
  const всё = после2.join(' ')
  ok('прежний выбор на месте', /TUI-тестер/.test(всё) && /Пока локально/.test(всё), всё)
  ok('новый выбор тоже виден', /На фейке/.test(всё), всё)
  if (shots) await page.screenshot({ path: join(shots, 'q-2-second.png') })
} finally {
  await app.close()
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка */
    }
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
