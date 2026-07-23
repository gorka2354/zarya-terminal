/**
 * Validates the canUseTool round-trip (the mechanism AskUserQuestion also uses):
 * ask Claude Code to run a shell command → a permission gate must surface as a
 * pendingTool → approve it → the tool executes in the SDK subprocess and a
 * tool_result comes back → the turn completes. Proves the permission resolve
 * path (renderer click -> IPC -> driver resolves canUseTool) works in Electron.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-ccp-'))
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

  await page.evaluate(() =>
    window.__zaryaAskAgent?.(
      'Запусти в bash команду: echo zarya-native-ok . Ничего больше не делай.',
      'claude-code'
    )
  )

  let approved = false
  const deadline = Date.now() + 90000
  let dump = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    dump = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (!dump) continue
    if (dump.error) break
    const pend = (dump.pendingTools || []).find((t) => !t.settled)
    if (pend && !approved) {
      console.log('  >> permission gate surfaced for tool:', pend.name, '— approving')
      await page.evaluate(() => window.__zaryaApproveFirst?.())
      approved = true
    }
    const hasResult = (dump.messages || []).some((m) =>
      m.content.some((p) => p.type === 'tool_result')
    )
    if (hasResult && !dump.streaming && (dump.pendingTools || []).length === 0) break
  }

  console.log('=== approved:', approved, '| streaming:', dump?.streaming, '| error:', dump?.error)
  for (const m of dump?.messages || []) {
    const txt = m.content
      .map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'tool_use'
            ? `[tool_use ${p.name} ${JSON.stringify(p.input).slice(0, 80)}]`
            : p.type === 'tool_result'
              ? `[tool_result ${p.isError ? 'ERR ' : ''}${(p.content || '').slice(0, 80)}]`
              : ''
      )
      .join(' ')
    console.log(`  ${m.role}: ${txt.slice(0, 200)}`)
  }
  console.log('=== console errors (' + errors.length + '):')
  for (const e of errors.slice(0, 10)) console.log('  !', e.slice(0, 200))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
