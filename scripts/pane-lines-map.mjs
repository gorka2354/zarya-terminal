/**
 * Карта горизонтальных линий панели: каждая помечена номером.
 *
 *   node scripts/pane-lines-map.mjs           # своя копия Зари (фейк)
 *
 * Спор о том, «какая полоса лишняя», словами не решается: их в верху панели
 * четыре штуки подряд, и все выглядят одинаково. Скрипт находит КАЖДУЮ черту —
 * границу, тонкий фон, кромку плашки — и подписывает её номером прямо на
 * экране. Дальше достаточно назвать номер.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ud = mkdtempSync(join(tmpdir(), 'zarya-lines-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-linesw-'))
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
  // Команда в терминале + ход агента: так в ленте есть и блоки, и беседа —
  // состояние, в котором владелец и видит лишнюю полосу.
  await page.evaluate(() => window.__zaryaRunCommand?.('echo привет'))
  await page.waitForTimeout(1800)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'tool edit: поправь файл'))
  await page.waitForTimeout(2800)

  const found = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const pane = [...document.querySelectorAll('.zy-pane')].filter(vis)[0]
    if (!pane) return []
    const box = pane.getBoundingClientRect()
    const out = []
    const push = (y, cls, what) => {
      if (y < box.top - 2 || y > box.top + 260) return
      // Линии в пределах двух пикселей — одна и та же черта на экране.
      if (out.some((o) => Math.abs(o.y - y) <= 2 && o.cls === cls)) return
      out.push({ y: Math.round(y), cls, what })
    }
    for (const el of pane.querySelectorAll('*')) {
      if (!vis(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < box.width * 0.25) continue
      const cs = getComputedStyle(el)
      const cls = (el.className?.toString?.() || el.tagName).slice(0, 40)
      if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none')
        push(r.top, cls, 'верхняя граница')
      if (cs.borderBottomWidth !== '0px' && cs.borderBottomStyle !== 'none')
        push(r.bottom, cls, 'нижняя граница')
      // Плашка со своим фоном: её кромка читается как линия ничуть не хуже.
      const bg = cs.backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && r.height > 6 && r.height < 120) {
        push(r.top, cls, 'кромка плашки (фон)')
        push(r.bottom, cls, 'кромка плашки (фон)')
      }
    }
    out.sort((a, b) => a.y - b.y)
    // Метки поверх мешают оценивать облик — рисуем их только по просьбе.
    const надо = !('ZARYA_NO_MARKS' in (window.__zaryaEnv ?? {}))
    for (const [i, o] of надо ? out.entries() : []) {
      const mark = document.createElement('div')
      mark.style.cssText = `position:fixed;left:${box.left + 6}px;top:${o.y - 9}px;z-index:99999;background:#e2231a;color:#fff;font:700 12px/16px monospace;padding:0 5px;border-radius:3px;pointer-events:none`
      mark.textContent = String(i + 1)
      document.body.appendChild(mark)
      const line = document.createElement('div')
      line.style.cssText = `position:fixed;left:${box.left}px;top:${o.y}px;width:${box.width}px;height:1px;z-index:99998;background:rgba(226,35,26,.55);pointer-events:none`
      document.body.appendChild(line)
    }
    return out
  })

  console.log('Линии сверху вниз:')
  found.forEach((o, i) => console.log(`  ${i + 1}) y=${o.y}  ${o.cls} — ${o.what}`))
  const shots = process.env.ZARYA_SHOTS
  if (shots) {
    await page.screenshot({
      path: join(shots, 'pane-lines.png'),
      clip: { x: 305, y: 32, width: 760, height: 420 },
      scale: 'css'
    })
    console.log('\nкартинка:', join(shots, 'pane-lines.png'))
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
