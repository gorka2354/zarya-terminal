/**
 * Под лентой терминал не рисуется, а в сыром режиме — рисуется.
 *
 *   node scripts/feed-overlay-test.mjs
 *
 * Владелец трижды приносил скриншот с широкой полосой поверх текста ленты.
 * Разбор через DevTools показал, ЧТО лежит под точкой: живой xterm с канвасами
 * прямо под непрозрачной лентой. Полоса — след перерисовки: композитор обновляет
 * регион нижнего слоя, лента в него не попадает, и на месте текста остаётся фон
 * терминала. Потому она и исчезала сама.
 *
 * Проверяется причина, а не симптом: пока на экране лента, терминал под ней
 * невидим (и, значит, не рисует кадров), а размеры сохраняет — иначе переход в
 * сырой режим вернул бы испорченную геометрию.
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
const section = (s) => console.log(`\n${s}`)

const ud = mkdtempSync(join(tmpdir(), 'zarya-ovl-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-ovlw-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { themeId: 'zarya-plakat', language: 'ru' },
    sessions: { restoreOnLaunch: 'none' }
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

/** Что сейчас с терминалом и лентой в видимой панели. */
const state = (page) =>
  page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    /*
     * Панель берём ВИДИМУЮ, а терминал — её собственный.
     *
     * Вкладок в окне несколько, и `querySelector` легко возвращает терминал
     * скрытой: нулевые размеры и «hidden» там законны, а прогон объявлял бы это
     * поломкой продукта.
     */
    const pane = [...document.querySelectorAll('.zy-pane')].filter(vis)[0] ?? document
    const wrap = pane.querySelector('.zy-term-wrap')
    const feed = [...pane.querySelectorAll('.zy-mf')].filter(vis)[0]
    const cs = wrap ? getComputedStyle(wrap) : null
    const r = wrap ? wrap.getBoundingClientRect() : null
    const fcs = feed ? getComputedStyle(feed) : null
    return {
      termVisibility: cs?.visibility ?? '(нет терминала)',
      termWidth: r ? Math.round(r.width) : 0,
      termHeight: r ? Math.round(r.height) : 0,
      feed: !!feed,
      feedContain: fcs?.contain ?? '',
      feedBg: fcs?.backgroundColor ?? ''
    }
  })

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
  await page.waitForTimeout(1800)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2400)

  section('[1] Лента на экране — терминал под ней погашен')
  const blocks = await state(page)
  note(JSON.stringify(blocks))
  ok('лента на месте', blocks.feed)
  ok('терминал невидим', blocks.termVisibility === 'hidden', blocks)
  // Размеры обязаны остаться: на них держится геометрия xterm, и «display: none»
  // здесь сломал бы возврат в сырой режим.
  ok('но размеры сохранены', blocks.termWidth > 100 && blocks.termHeight > 100, blocks)
  ok('лента замкнула свою отрисовку', /paint/.test(blocks.feedContain), blocks.feedContain)
  ok('и фон у неё непрозрачный', !/rgba\(0, 0, 0, 0\)/.test(blocks.feedBg), blocks.feedBg)

  section('[2] Сырой режим — терминал снова виден')
  await page.evaluate(() => window.__zaryaSetUi?.({ rawTerminal: true }))
  await page.waitForTimeout(1400)
  const raw = await state(page)
  note(JSON.stringify(raw))
  ok('терминал видим', raw.termVisibility === 'visible', raw)
  ok('ленты на экране нет', !raw.feed, raw)

  section('[3] Обратно в ленту — терминал снова гаснет, размеры целы')
  await page.evaluate(() => window.__zaryaSetUi?.({ rawTerminal: false }))
  await page.waitForTimeout(1400)
  const back = await state(page)
  note(JSON.stringify(back))
  ok('терминал погашен', back.termVisibility === 'hidden', back)
  ok('размеры не съехали', Math.abs(back.termWidth - blocks.termWidth) < 4, {
    было: blocks.termWidth,
    стало: back.termWidth
  })
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
