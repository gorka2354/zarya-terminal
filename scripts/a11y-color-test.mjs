/**
 * Смысл различим НЕ ТОЛЬКО ЦВЕТОМ (inc-43).
 *
 *   node scripts/a11y-color-test.mjs
 *
 * Повод — сравнение с чужим терминалом, где это заявлено прямо: «Meaning does
 * not rely on color alone». У Зари бо́льшая часть интерфейса так и сделана
 * (блоки команд ✓/✗, диффы +/−, топливомер числами), но нашлись четыре места,
 * где состояние держалось на одном оттенке. Хуже всего — пара «красный против
 * зелёного»: именно её не различает самый частый дальтонизм.
 *
 * Прогон проверяет то, чего не видно на снимке: что у РАЗНЫХ состояний РАЗНЫЕ
 * признаки помимо цвета. Снимок покажет, красиво ли; этот прогон — есть ли
 * вообще что показывать человеку, который цвет не различает.
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-a11y-'))
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

/**
 * Разметка глифа БЕЗ УЧЁТА ЦВЕТА.
 *
 * Сравниваем саму вёрстку: если у двух состояний она совпадает, различить их
 * можно только оттенком — ровно то, что чиним. Стили намеренно не читаем.
 */
const glyphOf = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    return el ? el.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 160) : null
  }, sel)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.()?.activeSessionId)
  const conv = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2500)
  ok('панель с агентом поднялась', !!sid && !!conv, { sid, conv })

  console.log('\n[1] Три ступени допуска — три РАЗНЫХ глифа')
  /*
   * Самое дорогое обещание интерфейса: спросят ли меня перед тем, как тронуть
   * файлы. Прежде на «спрашивать всё» и «правки без спроса» стоял ОДИН И ТОТ ЖЕ
   * замок, и различал их только цвет чипа.
   */
  const seen = []
  /* Снимок каждой ступени — решение о виде принимается глазами, а не по DOM. */
  const shotGate = async (name) => {
    if (!process.env.ZARYA_SHOT_DIR) return
    const el = await page.$('.zy-agentbar-gate')
    if (el) await el.screenshot({ path: join(process.env.ZARYA_SHOT_DIR, `gate-${name}.png`) })
  }
  seen.push({ label: 'спрашивать всё', glyph: await glyphOf(page, '.zy-agentbar-bypass') })
  await shotGate('1-ask')

  await page.evaluate((x) => window.__zaryaSetPaneEditsAuto?.(x, true), sid)
  await page.waitForTimeout(700)
  seen.push({ label: 'правки без спроса', glyph: await glyphOf(page, '.zy-agentbar-bypass') })
  await shotGate('2-edits')

  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), conv)
  await page.waitForTimeout(700)
  seen.push({ label: 'автопилот', glyph: await glyphOf(page, '.zy-agentbar-bypass') })
  await shotGate('3-auto')

  for (const s of seen) note(`${s.label}:`, JSON.stringify(String(s.glyph).slice(0, 64)))
  ok(
    'глифы у всех трёх состояний различаются',
    new Set(seen.map((s) => s.glyph)).size === 3,
    seen.map((s) => s.label + '=' + String(s.glyph).slice(0, 40))
  )

  console.log('\n[2] Уведомление несёт знак уровня, а не только цвет рамки')
  await page.evaluate(() => {
    const ui = window.__zaryaUi?.()
    ui?.toast?.('Скопировано', 'success')
    ui?.toast?.('Не скопировалось', 'error')
    ui?.toast?.('Просто новость', 'info')
  })
  await page.waitForTimeout(800)
  const toasts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-toast')).map((el) => ({
      kind: (el.className.match(/zy-toast--(\w+)/) ?? [])[1] ?? '?',
      glyph: el.querySelector('.zy-toast-glyph')?.textContent ?? '',
      text: el.querySelector('.zy-toast-text')?.textContent ?? ''
    }))
  )
  note('тосты:', JSON.stringify(toasts))
  ok('уведомления показались', toasts.length === 3, toasts.length)
  ok('у каждого есть знак уровня', toasts.every((x) => !!x.glyph), toasts)
  ok('знаки у трёх уровней РАЗНЫЕ', new Set(toasts.map((x) => x.glyph)).size === 3, toasts)
  ok('текст сообщения не потерялся', toasts.every((x) => x.text.length > 0), toasts)
  const live = await page.evaluate(
    () => document.querySelector('.zy-toasts')?.getAttribute('aria-live') ?? null
  )
  ok('область уведомлений объявляется скринридеру', live === 'polite', { live })

  console.log('\n[3] Полосы «ждёт» и «работает» различаются формой, а не оттенком')
  const bars = await page.evaluate(() => {
    const probe = (cls) => {
      const el = document.createElement('div')
      el.className = `zy-pane ${cls}`
      el.style.cssText = 'position:absolute;width:200px;height:40px;left:-9999px'
      document.body.appendChild(el)
      const s = getComputedStyle(el, '::before')
      const out = { image: s.backgroundImage || '', height: s.height }
      el.remove()
      return out
    }
    return { waiting: probe('zy-pane--waiting'), working: probe('zy-pane--working') }
  })
  note('ждёт:', bars.waiting.image.slice(0, 110))
  note('работает:', bars.working.image.slice(0, 110))
  ok('у ждущей полосы прерывистый рисунок', /repeating-linear/.test(bars.waiting.image), bars.waiting)
  ok(
    'у рабочей рисунок иной — форма отличается без цвета',
    !/repeating-linear/.test(bars.working.image) && bars.working.image !== bars.waiting.image,
    bars.working
  )

  console.log('\n[4] Что уже было сделано правильно — не сломано')
  const html = await page.evaluate(() => document.body.innerHTML)
  ok('знаки исхода команд на месте', /✓|✗|⋯/.test(html))
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
