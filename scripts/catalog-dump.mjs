/** Dump the FULL Claude model catalog (value, displayName, description, effort). */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-cat-'))
const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь: ок', 'claude-code'))
  const dl = Date.now() + 40000
  let models = []
  while (Date.now() < dl) { await page.waitForTimeout(1500); models = await page.evaluate(() => window.__zaryaClaudeModels?.()) || []; if (models.length) break }
  console.log('CATALOG (' + models.length + '):')
  for (const m of models) console.log(JSON.stringify(m))
} finally { await app.close(); try { rmSync(userData, { recursive: true, force: true }) } catch {} }
