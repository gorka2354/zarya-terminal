/** Verify the native Claude Code driver works in the PACKED build (asar layer). */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const exe = join(root, 'release', 'win-unpacked', 'Zarya.exe')
const userData = mkdtempSync(join(tmpdir(), 'zarya-pk-'))
const app = await electron.launch({
  executablePath: exe,
  args: [],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: работает', 'claude-code'))
  const deadline = Date.now() + 60000
  let dump = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    dump = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (!dump) continue
    if (dump.error) break
    if ((dump.messages || []).some((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'text' && p.text.trim())) && !dump.streaming) break
  }
  console.log('=== PACKED | engine:', dump?.engine, '| streaming:', dump?.streaming, '| error:', dump?.error)
  for (const m of dump?.messages || []) {
    console.log(`  ${m.role}:`, m.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(' ').slice(0, 120))
  }
  console.log('=== console errors (' + errors.length + '):')
  for (const e of errors.slice(0, 8)) console.log('  !', e.slice(0, 200))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
