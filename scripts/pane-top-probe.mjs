/**
 * Разведка: что рисует горизонтальные линии в верху панели.
 *
 *   node scripts/pane-top-probe.mjs
 *
 * Отчёт владельца: «полоса наверху как и в прошлый раз, там где инструменты по
 * типу поиск, но только ниже». Линию видно глазами, а вот КАКОЙ элемент её
 * даёт — нет: их там несколько подряд (шапка панели, лента, первая карточка).
 * Скрипт перечисляет всё, что даёт горизонтальную черту в верхних 200 пикселях
 * панели, с классом, координатой и источником — границей, фоном или тенью.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ud = mkdtempSync(join(tmpdir(), 'zarya-probe-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-probew-'))
// Тема как у владельца: линия видна именно в светлой.
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { themeId: 'zarya-plakat', language: 'ru', uiDensity: 'cozy' },
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
  /*
   * Лента как у владельца: ход человека, ответ агента и карточки инструментов.
   * Без содержимого линий не видно вовсе — прошлый заход это и показал.
   */
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'tool edit: поправь файл'))
  await page.waitForTimeout(2600)
  await page.evaluate(() => window.__zaryaFollowUp?.('tool edit: и ещё раз'))
  await page.waitForTimeout(2600)

  const lines = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const pane = [...document.querySelectorAll('.zy-pane, .zy-mf')].filter(vis)[0]
    const top = pane ? pane.getBoundingClientRect().top : 0
    const out = []
    for (const el of document.querySelectorAll('*')) {
      if (!vis(el)) continue
      const r = el.getBoundingClientRect()
      if (r.top < top - 5 || r.top > top + 200 || r.width < 120) continue
      const cs = getComputedStyle(el)
      const has = []
      if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none')
        has.push(`border-top ${cs.borderTopWidth} ${cs.borderTopColor}`)
      if (cs.borderBottomWidth !== '0px' && cs.borderBottomStyle !== 'none')
        has.push(`border-bottom ${cs.borderBottomWidth} ${cs.borderBottomColor}`)
      if (cs.boxShadow && cs.boxShadow !== 'none') has.push(`shadow ${cs.boxShadow.slice(0, 40)}`)
      if (r.height <= 3 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
        has.push(`тонкий фон ${cs.backgroundColor}`)
      if (!has.length) continue
      out.push({
        cls: el.className?.toString?.().slice(0, 60) || el.tagName,
        y: Math.round(r.top),
        h: Math.round(r.height),
        w: Math.round(r.width),
        что: has.join(' · ')
      })
    }
    return out
  })

  console.log('Горизонтальные черты в верху панели:')
  for (const l of lines) console.log(`  y=${l.y} h=${l.h} w=${l.w}  ${l.cls}\n      ${l.что}`)
  if (process.env.ZARYA_SHOTS) {
    await page.screenshot({
      path: join(process.env.ZARYA_SHOTS, 'pane-top.png'),
      clip: { x: 300, y: 34, width: 620, height: 170 }, scale: 'css'
    })
  }
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
