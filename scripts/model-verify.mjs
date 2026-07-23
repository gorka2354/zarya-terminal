/**
 * Verify Claude Code model + effort switching actually takes effect: for each
 * model choice, run a turn and read (a) the model that ACTUALLY ran (from the
 * result's modelUsage) and (b) the agent's own self-report. Then a live mid-
 * session switch. Uses an isolated instance — does NOT touch the running app.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-mv-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []

async function settle(page, ms = 70000) {
  const deadline = Date.now() + ms
  let d = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    d = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (d && !d.streaming && d.messages.some((m) => m.role === 'assistant')) break
  }
  return d
}
const lastAssistant = (d) => {
  const m = [...(d?.messages || [])].reverse().find((x) => x.role === 'assistant')
  return (m?.content || []).map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim().slice(0, 70)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  console.log('=== FRESH-CONV per model (setting -> model that ran -> agent says) ===')
  for (const model of ['', 'opus', 'sonnet', 'haiku']) {
    await page.evaluate((m) => window.__zaryaSetClaudeCfg?.(m), model)
    await page.evaluate(() =>
      window.__zaryaAskAgent?.('Одним словом назови свою модель: Opus, Sonnet, Haiku или Fable?', 'claude-code')
    )
    const d = await settle(page)
    const st = await page.evaluate(() => window.__zaryaClaudeStatus?.())
    console.log(`  set "${model || '(default)'}" -> ran: ${st?.model} | effort: ${st?.effort} | agent: "${lastAssistant(d)}"`)
  }

  console.log('\n=== EFFORT flows (setting -> status.effort) ===')
  for (const eff of ['low', 'max']) {
    await page.evaluate((e) => window.__zaryaSetClaudeCfg?.('sonnet', e), eff)
    await page.evaluate(() => window.__zaryaAskAgent?.('ответь: ок', 'claude-code'))
    await settle(page)
    const st = await page.evaluate(() => window.__zaryaClaudeStatus?.())
    console.log(`  set effort "${eff}" -> status.effort: ${st?.effort}`)
  }

  console.log('\n=== LIVE mid-session switch (default -> opus in same chat) ===')
  await page.evaluate(() => window.__zaryaSetClaudeCfg?.(''))
  await page.evaluate(() => window.__zaryaAskAgent?.('Назови свою модель одним словом.', 'claude-code'))
  let d = await settle(page)
  let st = await page.evaluate(() => window.__zaryaClaudeStatus?.())
  console.log(`  turn 1 -> ran: ${st?.model} | agent: "${lastAssistant(d)}"`)
  // Switch model live on the SAME conversation (exactly what the LaunchPad does).
  await page.evaluate(() => window.__zaryaApplyModelLive?.('opus'))
  await page.evaluate(() => window.__zaryaFollowUp?.('А теперь назови свою модель одним словом.'))
  d = await settle(page)
  st = await page.evaluate(() => window.__zaryaClaudeStatus?.())
  console.log(`  turn 2 (after live switch to opus) -> ran: ${st?.model} | agent: "${lastAssistant(d)}"`)

  console.log('\nconsole errors:', errors.length)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
