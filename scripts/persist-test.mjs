/**
 * Two-phase restart test: chat with Claude in TWO terminals, persist, relaunch
 * the SAME userData, and verify each terminal's conversation came back bound to
 * it. Also checks per-terminal binding (each terminal shows its own chat).
 *
 * Phase is chosen by argv[2]: run both sequentially sharing one userData dir.
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = join(tmpdir(), 'zarya-persist-fixed')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

async function launch() {
  return electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
  })
}

// ---- Phase 1: two terminals, two chats, persist ----
{
  const app = await launch()
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  // Terminal 1 already open; chat in it.
  let s = await page.evaluate(() => window.__zaryaDumpSessions?.())
  const sid1 = s.activeSessionId
  await page.evaluate(() => window.__zaryaAskAgent?.('Запомни слово АЛЬФА и повтори его.', 'claude-code'))
  await page.waitForTimeout(9000)

  // Open a second terminal, chat differently.
  await page.locator('.zy-sidebar-header .zy-icon-btn').first().click()
  await page.waitForTimeout(1200)
  s = await page.evaluate(() => window.__zaryaDumpSessions?.())
  const sid2 = s.activeSessionId
  await page.evaluate(() => window.__zaryaAskAgent?.('Запомни слово БЕТА и повтори его.', 'claude-code'))
  await page.waitForTimeout(9000)

  console.log('PHASE1 sid1=', sid1, 'conv1=', JSON.stringify(await page.evaluate((id) => window.__zaryaConvFor?.(id), sid1)))
  console.log('PHASE1 sid2=', sid2, 'conv2=', JSON.stringify(await page.evaluate((id) => window.__zaryaConvFor?.(id), sid2)))

  await page.evaluate(() => window.__zaryaPersistAll?.())
  await page.waitForTimeout(1500)
  await app.close()
  console.log('--- phase 1 persisted, restarting ---\n')
}

// ---- Phase 2: relaunch, verify restore + per-terminal binding ----
{
  const app = await launch()
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(4000) // restore takes a moment

  const s = await page.evaluate(() => window.__zaryaDumpSessions?.())
  console.log('PHASE2 restored tabs=', s.tabs.length, 'sessions=', s.sessions.length)
  for (const sess of s.sessions) {
    const conv = await page.evaluate((id) => window.__zaryaConvFor?.(id), sess.id)
    console.log(`  terminal ${sess.id} (cwd ${sess.cwd}) -> conv:`, JSON.stringify(conv))
  }
  // Selection: click each restored terminal in the sidebar; verify active follows.
  const items = page.locator('.zy-sidebar-body .zy-item')
  for (let i = 0; i < s.tabs.length; i++) {
    await items.nth(i).click()
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => window.__zaryaDumpSessions?.())
    console.log(`  select #${i} -> activeSession=${after.activeSessionId}`)
  }

  // Resume: on the first terminal, ask Claude for the remembered word.
  await items.nth(0).click()
  await page.waitForTimeout(500)
  const active = await page.evaluate(() => window.__zaryaDumpSessions?.())
  console.log('\nRESUME test on active terminal', active.activeSessionId)
  await page.evaluate(() => window.__zaryaFollowUp?.('Какое слово я просил тебя запомнить ранее в этом разговоре? Ответь ровно одним словом.'))
  const deadline = Date.now() + 60000
  let conv = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    conv = await page.evaluate((id) => window.__zaryaConvFor?.(id), active.activeSessionId)
    const full = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (full && !full.streaming && full.messages.length >= 3) { conv = full; break }
  }
  const lastAssistant = [...(conv?.messages || [])].reverse().find((m) => m.role === 'assistant')
  const reply = lastAssistant?.content?.map((p) => (p.type === 'text' ? p.text : '')).join(' ') || ''
  console.log('  Claude reply:', reply.slice(0, 120))
  console.log('  >> remembers context (АЛЬФА/БЕТА)?', /альфа|бета/i.test(reply))

  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'persist.png') })
  console.log('console errors:', errors.length)
  for (const e of errors.slice(0, 8)) console.log('  !', e.slice(0, 160))
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
