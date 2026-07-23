/**
 * End-to-end smoke test for the native Claude Code driver INSIDE Electron.
 * Launches the built app (isolated userData), drives a claude-code agent turn
 * via the __zaryaAskAgent hook, and reads back the conversation — verifying the
 * ESM dynamic import + subprocess spawn + streaming all work in the packaged
 * main process. Prints console errors and the final assistant text / any error.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-cc-'))

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})

const errors = []
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.waitForTimeout(2500)

  // Kick off a native Claude Code turn.
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: работает', 'claude-code'))

  // Poll the conversation until an assistant reply, an error, or timeout.
  const deadline = Date.now() + 60000
  let dump = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    dump = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (!dump) continue
    if (dump.error) break
    const hasAssistant = (dump.messages || []).some(
      (m) => m.role === 'assistant' && m.content.some((p) => p.type === 'text' && p.text.trim())
    )
    if (hasAssistant && !dump.streaming) break
  }

  console.log('=== engine:', dump?.engine, '| streaming:', dump?.streaming, '| error:', dump?.error)
  for (const m of dump?.messages || []) {
    const txt = m.content
      .map((p) =>
        p.type === 'text' ? p.text : p.type === 'tool_use' ? `[tool_use ${p.name}]` : p.type === 'tool_result' ? `[tool_result]` : ''
      )
      .join(' ')
    console.log(`  ${m.role}: ${txt.slice(0, 160)}`)
  }
  console.log('=== console errors (' + errors.length + '):')
  for (const e of errors.slice(0, 12)) console.log('  !', e.slice(0, 200))

  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'cc-native.png') })
  console.log('shot: shots/cc-native.png')
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
