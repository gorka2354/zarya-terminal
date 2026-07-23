/** EXACT user scenario, ONE conversation:
 *  turn 1 with bypass ON  -> action runs WITHOUT asking;
 *  turn 2 (same session) after toggling bypass OFF live -> action ASKS to approve. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-rt-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const CMD = 'Выполни ровно одну bash-команду: curl -s https://api.github.com/zen . Больше ничего.'
const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())

// Returns 'gated' if a run-tool is waiting for approval, or 'done' if the turn finished with no gate.
async function outcome(page, ms = 45000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(1200)
    const d = await dump(page)
    if (!d) continue
    if ((d.pendingTools || []).some((t) => t.kind !== 'question' && !t.settled)) return 'GATED (спросил)'
    if (!d.streaming && d.messages.some((m) => m.role === 'assistant') && (d.pendingTools || []).length === 0)
      return 'DONE (без спроса)'
  }
  return 'timeout'
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // Turn 1: bypass ON, then start ONE conversation.
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  await page.evaluate((c) => window.__zaryaAskAgent?.(c, 'claude-code'), CMD)
  const t1 = await outcome(page)
  console.log('ХОД 1 (bypass ВКЛ):', t1)

  // Toggle bypass OFF LIVE on the SAME conversation, then a follow-up.
  await page.evaluate(() => window.__zaryaBypassLive?.(false))
  const before = await dump(page)
  const sameConv = before?.messages?.length ?? 0
  await page.evaluate((c) => window.__zaryaFollowUp?.(c), CMD)
  const t2 = await outcome(page)
  console.log('ХОД 2 (в той же беседе, bypass ВЫКЛ):', t2)

  console.log('\nВЕРДИКТ (точный сценарий): ',
    t1.startsWith('DONE') && t2.startsWith('GATED')
      ? 'РАБОТАЕТ — ВКЛ без спроса, потом ВЫКЛ в той же сессии → спросил'
      : `не сошлось (t1=${t1}, t2=${t2})`)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
