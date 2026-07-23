/** Verify (1) live bypass toggle actually stops permission gating mid-session,
 *  and (2) global Esc interrupts the agent without focusing the input. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-be-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
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
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // ---- (2) GLOBAL ESC: start a long turn, click the FEED (not the input), press Esc ----
  console.log('=== GLOBAL ESC (no input focus) ===')
  await page.evaluate(() => window.__zaryaAskAgent?.('Медленно посчитай от 1 до 40, по одному числу на строку, не торопись.', 'claude-code'))
  await page.waitForTimeout(2500)
  let d = await dump(page)
  console.log('  streaming before Esc:', d?.streaming)
  // Focus something that is NOT the agent input (the sessions search box).
  await page.locator('.zy-sidebar-search input').click().catch(() => {})
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  d = await dump(page)
  console.log('  streaming after Esc (blur input):', d?.streaming, '-> interrupted:', d?.streaming === false)

  // ---- (1) LIVE BYPASS: turn bypass ON mid-session, then ask for a gated action ----
  console.log('\n=== LIVE BYPASS toggle ===')
  await settle(page)
  // Toggle bypass ON on the active conversation LIVE (exactly like the chip).
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  await page.evaluate(() => window.__zaryaFollowUp?.('Создай файл zbypass_test.txt со словом привет (инструмент Write), затем прочитай его.'))
  d = await settle(page)
  const gated = (d?.messages || []).length && await page.evaluate(() => {
    const c = window.__zaryaDumpConv?.()
    return (c?.pendingTools || []).length
  })
  const toolMsgs = (d?.messages || []).flatMap((m) => m.content.filter((p) => p.type === 'tool_use').map((p) => p.name))
  console.log('  tools used:', JSON.stringify(toolMsgs))
  console.log('  pending (gated) tools after bypass:', gated, '-> auto-approved:', !gated)
  console.log('  final: streaming', d?.streaming, '| error', d?.error)

  console.log('\nconsole errors:', errors.length)
  for (const e of errors.slice(0, 6)) console.log('  !', e.slice(0, 150))
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
