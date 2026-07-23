/**
 * Walk the platform like a user: open several terminals, click between them in
 * the sidebar (reproduce the "can't select session" bug), chat with Claude in
 * two different terminals, and check whether each terminal shows its OWN AI
 * conversation. Reports the tab/session/conversation state at each step.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-wt-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
mkdirSync(join(root, 'shots'), { recursive: true })
const dumpS = (page) => page.evaluate(() => window.__zaryaDumpSessions?.())
const dumpC = (page) => page.evaluate(() => window.__zaryaDumpConv?.())

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)

  // Open two more terminals (the "+" in the sidebar header).
  const plus = page.locator('.zy-sidebar-header .zy-icon-btn').first()
  await plus.click(); await page.waitForTimeout(900)
  await plus.click(); await page.waitForTimeout(900)
  let s = await dumpS(page)
  console.log('after opening 3 terminals: tabs=', s.tabs.length, 'active=', s.activeTabId)

  // Click each open-tab item in the sidebar and check the active tab follows.
  const items = page.locator('.zy-sidebar-body .zy-item')
  const n = await items.count()
  console.log('sidebar items (incl. crew):', n)
  for (let i = 0; i < Math.min(3, s.tabs.length); i++) {
    await items.nth(i).click()
    await page.waitForTimeout(500)
    const after = await dumpS(page)
    console.log(`  click sidebar item #${i} -> activeTabId=${after.activeTabId} (tab#${after.tabs.findIndex((t) => t.id === after.activeTabId)})`)
  }

  // Chat with Claude in the CURRENT terminal.
  await page.evaluate(() => window.__zaryaAskAgent?.('Скажи одним словом: терминал-один', 'claude-code'))
  await page.waitForTimeout(9000)
  let c = await dumpC(page)
  console.log('\nterminal A conversation engine=', c?.engine, 'msgs=', c?.messages?.length, 'sessionBound=', c ? '(see below)' : null)
  s = await dumpS(page)
  console.log('active terminal session:', s.activeSessionId)

  // Switch to a DIFFERENT terminal, chat again.
  await items.nth(0).click(); await page.waitForTimeout(600)
  const sA = await dumpS(page)
  await page.evaluate(() => window.__zaryaAskAgent?.('Скажи одним словом: терминал-два', 'claude-code'))
  await page.waitForTimeout(9000)
  console.log('\nafter switching terminal + new chat: activeSession=', sA.activeSessionId)

  // Now switch back to the first terminal — does its OWN conversation show?
  await items.nth(2).click(); await page.waitForTimeout(800)
  const cBack = await dumpC(page)
  console.log('\nswitched back — shown conversation msgs=', cBack?.messages?.length, 'first user text=',
    cBack?.messages?.find((m) => m.role === 'user')?.content?.[0]?.text?.slice(0, 40))
  console.log('   >> Does the feed follow the active terminal? (expected: each terminal its own chat)')

  await page.screenshot({ path: join(root, 'shots', 'walkthrough.png') })
  console.log('\nconsole errors:', errors.length)
  for (const e of errors.slice(0, 6)) console.log('  !', e.slice(0, 160))
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
