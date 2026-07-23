/** Verify dynamic model catalog (SDK-driven) + per-model effort + ultracode. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-dyn-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
async function settle(page, ms = 60000) {
  const dl = Date.now() + ms
  let d = null
  while (Date.now() < dl) {
    await page.waitForTimeout(1500)
    d = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (d && !d.streaming && d.messages.some((m) => m.role === 'assistant')) break
  }
  return d
}
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // Trigger a session so init -> supportedModels fires.
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь: ок', 'claude-code'))
  await settle(page)
  await page.waitForTimeout(1500)

  const models = await page.evaluate(() => window.__zaryaClaudeModels?.())
  console.log('=== DYNAMIC MODEL CATALOG (', models?.length, 'models) ===')
  for (const m of (models || []).slice(0, 12)) {
    console.log(`  ${m.value}  | ${m.displayName} | effort:[${(m.supportedEffortLevels || []).join(',')}]${m.supportsEffort === false ? ' (no effort)' : ''}`)
  }

  // Ultracode: enable and send — verify it doesn't crash the driver.
  console.log('\n=== ULTRACODE toggle ===')
  await page.evaluate(() => window.__zaryaSetUi?.({ ultracode: true }))
  await page.evaluate(() => window.__zaryaFollowUp?.('ответь одним словом: ультра'))
  const d = await settle(page)
  const reply = [...(d?.messages || [])].reverse().find((m) => m.role === 'assistant')?.content?.map((p) => p.type === 'text' ? p.text : '').join(' ').slice(0, 60)
  console.log('  ultracode on -> streaming done:', !d?.streaming, '| error:', d?.error, '| reply:', reply)

  console.log('\nconsole errors:', errors.length)
  for (const e of errors.slice(0, 8)) console.log('  !', e.slice(0, 160))
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
