/** Verify the resume picker: list past Claude sessions for a folder, load one. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-sess-'))
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

  // Create a Claude session in the current folder.
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.evaluate(() => window.__zaryaAskAgent?.('Запомни слово ГАММА и повтори.', 'claude-code'))
  await page.waitForTimeout(9000)
  const s = await page.evaluate(() => window.__zaryaDumpSessions?.())
  const cwd = s.sessions.find((x) => x.id === s.activeSessionId)?.cwd
  console.log('cwd:', cwd)

  // List past Claude sessions for this folder.
  const list = await page.evaluate((c) => window.zarya.claudeCode.listSessions(c), cwd)
  console.log('listSessions ->', list.length, 'sessions')
  console.log('  first:', JSON.stringify(list[0] && { summary: list[0].summary?.slice(0, 40), branch: list[0].gitBranch }))

  if (list[0]) {
    const msgs = await page.evaluate(
      ([id, c]) => window.zarya.claudeCode.sessionMessages(id, c),
      [list[0].sessionId, cwd]
    )
    console.log('sessionMessages ->', msgs.length, 'messages; first user:',
      msgs.find((m) => m.role === 'user')?.content?.find((p) => p.type === 'text')?.text?.slice(0, 40))
  }

  // Open the header "sessions" menu and screenshot it.
  await page.locator('.zy-mf-head-btn[title*="Сессии"]').click()
  await page.waitForTimeout(500)
  const menuItems = await page.locator('.zy-context-item').allTextContents()
  console.log('resume menu items:', menuItems.length, '| sample:', JSON.stringify(menuItems.slice(0, 3)))
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'sessions.png') })
  console.log('console errors:', errors.length)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
