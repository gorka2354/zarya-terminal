/** Capture base (default, IDE off) vs IDE-on: activity bar + settings grouping. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-ide-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const shot = async (page, name) => {
  mkdirSync(join(root, 'shots', 'ide'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'ide', name) })
  console.log('shot:', name)
}
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  // 1) BASE (default, IDE off) — full window.
  await shot(page, '01-base.png')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(600)
  await shot(page, '02-base-settings.png')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false }))

  // 2) Turn IDE ON.
  await page.evaluate(() => window.zarya.settings.set({ ideMode: true }))
  await page.waitForTimeout(800)
  await shot(page, '03-ide-on.png')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(600)
  await shot(page, '04-ide-settings.png')
  console.log('done')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
