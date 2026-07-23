/** Verify the "+" dropdown: open a bookmarked project folder as a new terminal. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-fld-'))
const projectDir = join(homedir(), 'Desktop')
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ bookmarks: [projectDir], sessions: { restoreOnLaunch: 'none' } }, null, 2)
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)

  // Open the ▾ dropdown (2nd icon button in the sessions header).
  await page.locator('.zy-sidebar-header .zy-icon-btn').nth(1).click()
  await page.waitForTimeout(400)
  const menuItems = await page.locator('.zy-context-item').allTextContents()
  console.log('menu items:', JSON.stringify(menuItems))
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'folder-menu.png') })

  // Click the bookmarked project item.
  await page.locator('.zy-context-item', { hasText: 'Desktop' }).first().click()
  await page.waitForTimeout(1800)
  const s = await page.evaluate(() => window.__zaryaDumpSessions?.())
  console.log('sessions after open:', JSON.stringify(s.sessions.map((x) => x.cwd)))
  const opened = s.sessions.find((x) => (x.cwd || '').toLowerCase().includes('desktop'))
  console.log('>> opened terminal in project folder?', !!opened, opened?.cwd)
  console.log('console errors:', errors.length)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
