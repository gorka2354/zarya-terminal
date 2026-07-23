/** Verify the fuel gauge: chat with Claude, then read model/effort/usage + shot. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-fuel-'))
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
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.evaluate(() => window.__zaryaAskAgent?.('привет одним словом', 'claude-code'))

  const deadline = Date.now() + 70000
  let st = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000)
    st = await page.evaluate(() => window.__zaryaClaudeStatus?.())
    if (st?.usage && (st.usage.fiveHourPct != null || st.usage.subscriptionType)) break
  }
  console.log('claudeStatus:', JSON.stringify(st))
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'fuel.png') })
  console.log('console errors:', errors.length)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
