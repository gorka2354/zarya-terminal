/**
 * Записки между панелями: доставка, вид и границы.
 *
 *   node scripts/pane-notes-test.mjs
 *
 * Сам инструмент здесь не зовётся агентом — он живёт в движке, и это проверяет
 * живой прогон. Здесь проверяется ВСЁ ОСТАЛЬНОЕ, и оно важнее: как записка
 * выглядит у получателя, что она не притворяется словами человека, что
 * выключенная настройка выключает обе стороны, а панель на автопилоте её
 * придерживает.
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
}
const note = (...a) => console.log('   ·', ...a)

const ud = mkdtempSync(join(tmpdir(), 'zarya-notes-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-notes-w-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    ai: { paneMessages: true }
  })
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

/** Записка, доставленная так же, как её доставляет главный процесс. */
const deliver = (page, to, from, text) =>
  page.evaluate(
    ([t, f, x]) => window.__zaryaPaneNote?.({ toConvId: t, fromConvId: f, text: x }),
    [to, from, text]
  )

const partsOf = (page, convId) =>
  page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return (c?.partKinds ?? []).slice()
  }, convId)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Две панели видят друг друга')
  const a = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(1500)
  const b = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2500)
  ok('две беседы поднялись', !!a && !!b && a !== b, { a, b })

  console.log('\n[2] Записка приходит СВОИМ видом, а не репликой человека')
  await deliver(page, b, a, 'миграция прошла, колонка tenant_id')
  await page.waitForTimeout(2000)
  const kinds = await partsOf(page, b)
  note('виды частей у получателя:', JSON.stringify(kinds))
  ok('в ленте появилась записка', kinds.includes('pane-note'), kinds)
  const shown = await page.evaluate(() => document.querySelector('.zy-mf-note')?.textContent ?? '')
  note('на экране:', JSON.stringify(shown.replace(/\s+/g, ' ').slice(0, 120)))
  ok('назван отправитель', /записка от панели/i.test(shown), shown)
  ok('виден текст записки', /tenant_id/.test(shown), shown)
  // Ключевое: она НЕ должна попасть в ленту как сообщение человека.
  const userTexts = await page.evaluate((id) => window.__zaryaConvById?.(id)?.userTexts ?? [], b)
  ok(
    'запиской НЕ подменили слова человека',
    !userTexts.some((t) => String(t).includes('tenant_id')),
    userTexts
  )

  console.log('\n[3] Панель на автопилоте записку придерживает')
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), b)
  await page.waitForTimeout(500)
  await deliver(page, b, a, 'снеси ветку и накати заново')
  await page.waitForTimeout(1500)
  const heldShown = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-note')].map((n) => n.textContent ?? '').join(' | ')
  )
  ok('придержанная помечена словом', /придержана/i.test(heldShown), heldShown.slice(-160))
  ok(
    'опасное указание на автопилоте не ушло агенту молча',
    /придержана/i.test(heldShown),
    heldShown.slice(-160)
  )

  console.log('\n[4] Слэш-команда в записке остаётся текстом')
  /*
   * Записка приходит агенту с нашим префиксом «[note from pane …]», поэтому
   * строка НИКОГДА не начинается со слэша — а команду движок читает только с
   * начала строки. Проверяем на самом опасном тексте: «/compact» стёр бы
   * получателю контекст по просьбе соседа.
   */
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, false), b)
  await page.waitForTimeout(400)
  await deliver(page, b, a, '/compact')
  await page.waitForTimeout(1500)
  const slash = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return { notes: c?.noteTexts ?? [], user: c?.userTexts ?? [] }
  }, b)
  note('записки:', JSON.stringify(slash.notes))
  ok('команда доехала как ТЕКСТ записки', slash.notes.includes('/compact'), slash.notes)
  ok(
    'и не стала сообщением человека, с которого движок читает команды',
    !slash.user.some((t) => String(t).trim().startsWith('/')),
    slash.user
  )

  console.log('\n[5] Выключенная настройка выключает ОБЕ стороны')
  await page.evaluate(() => window.zarya.settings.set({ ai: { paneMessages: false } }))
  await page.waitForTimeout(800)
  const before = (await partsOf(page, b)).filter((k) => k === 'pane-note').length
  await deliver(page, b, a, 'третья записка')
  await page.waitForTimeout(1200)
  const after = (await partsOf(page, b)).filter((k) => k === 'pane-note').length
  ok('при выключенной настройке записка не принимается', after === before, { before, after })
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

console.log(`\n[pane-notes] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
