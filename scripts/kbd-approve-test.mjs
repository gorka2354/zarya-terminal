import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-kb-'))
const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
const CMD = 'Выполни ровно одну bash-команду: curl -s https://api.github.com/zen . Больше ничего.'
const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())
const gated = (d) => (d?.pendingTools || []).some((t) => t.kind !== 'question' && !t.settled)
async function waitGate(page, ms = 40000) { const dl = Date.now() + ms; while (Date.now() < dl) { await page.waitForTimeout(1000); const d = await dump(page); if (gated(d)) return d; if (d && !d.streaming && d.messages.some((m) => m.role === 'assistant')) return d } return dump(page) }
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.evaluate(() => window.__zaryaBypassLive?.(false))
  await page.evaluate((c) => window.__zaryaAskAgent?.(c, 'claude-code'), CMD)
  let d = await waitGate(page)
  console.log('gated (before Enter):', gated(d))
  const input = page.locator('.zy-agentbar-input'); await input.click(); await input.fill('')
  await page.keyboard.press('Enter')
  // wait generously for the approved echo to run + result
  const dl = Date.now() + 25000; let ran = false
  while (Date.now() < dl) { await page.waitForTimeout(1500); d = await dump(page); if ((d?.messages || []).some((m) => m.content.some((p) => p.type === 'tool_result' && /./.test(p.content || '')))) { ran = true; break } }
  console.log('after Enter -> tool ran (approved):', ran, '| still gated:', gated(d))
  console.log('VERDICT approve-via-Enter:', ran ? 'РАБОТАЕТ' : 'НЕ РАБОТАЕТ')
} finally { await app.close(); try { rmSync(userData, { recursive: true, force: true }) } catch {} }
