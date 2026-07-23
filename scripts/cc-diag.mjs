/** Diagnostic: reproduce the user's vague "предложи выбор" prompt and see whether
 * Claude emits an AskUserQuestion tool_use (→ native widget) or plain text. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-dg-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() =>
    window.__zaryaAskAgent?.(
      'привет, предложи мне что то с выбором из нескольких пунктов (хочу выбрать для теста что то стрелочками и подтвердить это)',
      'claude-code'
    )
  )
  const deadline = Date.now() + 70000
  let dump = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    dump = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (!dump) continue
    if (dump.error) break
    const q = (dump.pendingTools || []).find((t) => t.kind === 'question')
    if (q) break
    if (!dump.streaming && (dump.messages || []).some((m) => m.role === 'assistant')) break
  }
  console.log('=== streaming:', dump?.streaming, '| error:', dump?.error)
  console.log('=== pendingTools:', JSON.stringify((dump?.pendingTools || []).map((t) => ({ name: t.name, kind: t.kind, hasQ: !!t.questions }))))
  for (const m of dump?.messages || []) {
    console.log(`--- ${m.role}:`)
    for (const p of m.content) {
      if (p.type === 'text') console.log(`    text: ${p.text.replace(/\n/g, ' ⏎ ').slice(0, 220)}`)
      else if (p.type === 'tool_use') console.log(`    tool_use[${p.name}]: ${JSON.stringify(p.input).slice(0, 220)}`)
      else if (p.type === 'tool_result') console.log(`    tool_result: ${(p.content || '').slice(0, 120)}`)
    }
  }
  const hasWidget = await page.evaluate(() => !!document.querySelector('.zy-cqb'))
  console.log('=== ClaudeQuestionBar rendered:', hasWidget)
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
