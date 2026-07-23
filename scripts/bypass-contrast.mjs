/** Contrast: a network curl GATES without bypass, and does NOT gate with bypass. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-bc-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const CMD = 'Выполни ровно одну bash-команду: curl -s https://api.github.com/zen . Ничего больше.'
const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())

async function waitGateOrDone(page, ms = 45000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(1200)
    const d = await dump(page)
    if (!d) continue
    const gate = (d.pendingTools || []).find((t) => t.kind !== 'question' && !t.settled)
    if (gate) return { gated: true, d }
    if (!d.streaming && d.messages.some((m) => m.role === 'assistant') && (d.pendingTools || []).length === 0)
      return { gated: false, d }
  }
  return { gated: false, d: await dump(page), timeout: true }
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // (A) bypass OFF
  await page.evaluate(() => window.__zaryaBypassLive?.(false))
  await page.evaluate((c) => window.__zaryaAskAgent?.(c, 'claude-code'), CMD)
  const a = await waitGateOrDone(page)
  console.log('bypass OFF -> gated (asked to approve)?', a.gated, a.timeout ? '(timeout)' : '')
  // clean up: deny if gated so the turn ends
  if (a.gated) await page.evaluate(() => window.__zaryaDumpConv && (window.__zaryaSetUi?.({}), null))

  // (B) bypass ON — fresh conversation
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  await page.evaluate((c) => window.__zaryaAskAgent?.(c, 'claude-code'), CMD)
  const b = await waitGateOrDone(page)
  console.log('bypass ON  -> gated (asked to approve)?', b.gated, b.timeout ? '(timeout)' : '')

  console.log('\nVERDICT: bypass works =', a.gated === true && b.gated === false,
    '(off gated, on did not)')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
