/** Screenshot of the bottom bar — collapsed and with the usage panel open. */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const out = process.env.SHOT_DIR || join(root, 'shots')
const userData = mkdtempSync(join(tmpdir(), 'zarya-bar-'))

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)

  // Seed a plausible readout so the panel has something to show offline.
  await page.evaluate(() => {
    window.__zaryaSetUi?.({
      claudeStatus: {
        model: 'claude-opus-4-5',
        effort: 'xhigh',
        usage: {
          subscriptionType: 'Max',
          fiveHourPct: 14,
          fiveHourResetsAt: Date.now() + 3 * 3600e3 + 2 * 60e3,
          sevenDayPct: 18,
          sevenDayResetsAt: Date.now() + 4 * 24 * 3600e3
        }
      },
      agentContext: { pct: 32, tokens: 48000, window: 200000, engine: 'claude-code' },
      barMode: 'claude-code'
    })
  })
  await page.waitForTimeout(600)

  const chips = await page.$('.zy-agentbar-row')
  const cb = await chips.boundingBox()
  await page.screenshot({ path: join(out, 'chips-zoom.png'), clip: { x: cb.x, y: cb.y, width: 130, height: cb.height } })
  console.log('→ chips-zoom.png')
  const bar = await page.$('.zy-agentbar')
  await bar?.screenshot({ path: join(out, 'bar-collapsed.png') })
  console.log('→ bar-collapsed.png')

  await page.click('.zy-agentbar-fuel-main')
  await page.waitForTimeout(400)
  // Capture bar + panel together.
  const box = await bar?.boundingBox()
  if (box) {
    await page.screenshot({
      path: join(out, 'bar-usage.png'),
      clip: {
        x: box.x,
        y: Math.max(0, box.y - 150),
        width: box.width,
        height: box.height + 150
      }
    })
    console.log('→ bar-usage.png')
  }
} finally {
  await app.close()
}
