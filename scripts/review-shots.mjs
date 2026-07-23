/** Capture key surfaces of the current build for a visual UX review. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-rv-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const shot = async (page, name) => {
  mkdirSync(join(root, 'shots', 'review'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'review', name) })
  console.log('shot:', name)
}
const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())
async function settle(page, ms = 60000) {
  const dl = Date.now() + ms
  let d = null
  while (Date.now() < dl) {
    await page.waitForTimeout(1200)
    d = await dump(page)
    if (d && !d.streaming && (d.pendingTools || []).length === 0 && d.messages.some((m) => m.role === 'assistant')) break
  }
  return d
}
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.waitForTimeout(1200)

  // 1) Empty state (claude mode): tiles + resume list.
  await shot(page, '01-empty.png')

  // 2) A multi-tool turn — assess feed density + tool cards.
  await page.evaluate(() =>
    window.__zaryaBypassLive?.(true) // avoid gating so tools run + we see results
  )
  await page.evaluate(() =>
    window.__zaryaAskAgent?.('Выполни по очереди три bash-команды: echo раз ; node --version ; echo три. Коротко подытожь.', 'claude-code')
  )
  await settle(page)
  await page.waitForTimeout(800)
  await shot(page, '02-feed-tools.png')

  // 3) Launch pad (dynamic models + effort + ultracode).
  await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: true }))
  await page.waitForTimeout(700)
  await shot(page, '03-launchpad.png')
  await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: false }))

  // 4) Command palette (discoverability).
  await page.evaluate(() => window.__zaryaSetUi?.({ paletteOpen: true }))
  await page.waitForTimeout(500)
  await shot(page, '04-palette.png')
  await page.evaluate(() => window.__zaryaSetUi?.({ paletteOpen: false }))

  // 5) Settings.
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(600)
  await shot(page, '05-settings.png')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false }))

  console.log('done')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
