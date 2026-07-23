/** Verify CLI-style queueing: send, queue a follow-up while working, confirm it
 * auto-sends after the turn. Also shots the empty-feed resume list. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-q-'))
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

  // Shot the empty feed (should show the recent-sessions resume list for cwd).
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.waitForTimeout(1500)
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'empty-resume.png') })
  const hasList = await page.evaluate(() => !!document.querySelector('.zy-resume-item'))
  console.log('empty-feed resume list present:', hasList)

  // Start a turn, then queue a follow-up WHILE streaming.
  await page.evaluate(() => window.__zaryaAskAgent?.('Посчитай от 1 до 5, каждое число с новой строки.', 'claude-code'))
  await page.waitForTimeout(1200)
  await page.evaluate(() => window.__zaryaQueue?.('А теперь ответь одним словом: очередь-работает'))
  let d = await page.evaluate(() => window.__zaryaDumpConv?.())
  console.log('while streaming -> streaming:', d?.streaming, '| queued:', JSON.stringify(d?.queued))

  // Wait for both turns (queued auto-sends after the first completes).
  const deadline = Date.now() + 80000
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000)
    d = await page.evaluate(() => window.__zaryaDumpConv?.())
    const userTurns = (d?.messages || []).filter((m) => m.role === 'user').length
    if (!d?.streaming && !d?.queued && userTurns >= 2) break
  }
  const userMsgs = (d?.messages || []).filter((m) => m.role === 'user').map((m) => m.content.find((p) => p.type === 'text')?.text?.slice(0, 40))
  console.log('final user turns:', JSON.stringify(userMsgs))
  console.log('queued auto-sent after turn:', userMsgs.some((t) => /очередь/i.test(t || '')))
  console.log('console errors:', errors.length)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
