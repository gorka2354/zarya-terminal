/** Screenshot the LaunchPad in Claude mode (dynamic models + effort + ultracode). */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-pad-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  // Trigger a session so the model catalog loads.
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь: ок', 'claude-code'))
  const dl = Date.now() + 40000
  while (Date.now() < dl) {
    await page.waitForTimeout(1500)
    const m = await page.evaluate(() => window.__zaryaClaudeModels?.())
    if (m && m.length) break
  }
  await page.waitForTimeout(800)
  // Pick opus so effort chips show, then open the pad.
  await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: true }))
  await page.waitForTimeout(700)
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'pad-claude.png') })
  console.log('shot: shots/pad-claude.png')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
