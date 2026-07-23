/**
 * Validates the signature feature: Claude Code's AskUserQuestion surfaces as a
 * native choice (pendingTool kind:'question') and answering it via the store
 * resolves canUseTool so the agent continues. AskUserQuestion always routes
 * through canUseTool (allow-rules can't bypass it), so this is deterministic
 * once the model decides to ask.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-ccq-'))
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
      'Используй инструмент AskUserQuestion, чтобы задать мне РОВНО один уточняющий вопрос с 3 вариантами: «какой цвет темы предпочитаешь». Не делай ничего другого до моего ответа.',
      'claude-code'
    )
  )

  let answered = false
  let sawQuestion = false
  const deadline = Date.now() + 90000
  let dump = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    dump = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (!dump) continue
    if (dump.error) break
    const q = (dump.pendingTools || []).find((t) => t.kind === 'question' && !t.settled)
    if (q && !answered) {
      sawQuestion = true
      const opt = q.questions?.[0]?.options?.[0]?.label
      console.log('  >> AskUserQuestion surfaced:', JSON.stringify(q.questions?.[0]?.question), '| picking:', opt)
      await page.evaluate((label) => window.__zaryaAnswerFirst?.(label), opt || 'Первый')
      answered = true
    }
    if (answered && !dump.streaming && (dump.pendingTools || []).length === 0) break
  }

  console.log('=== sawQuestion:', sawQuestion, '| answered:', answered, '| streaming:', dump?.streaming, '| error:', dump?.error)
  for (const m of dump?.messages || []) {
    const txt = m.content
      .map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'tool_use'
            ? `[tool_use ${p.name} ${JSON.stringify(p.input).slice(0, 120)}]`
            : p.type === 'tool_result'
              ? `[tool_result ${(p.content || '').slice(0, 60)}]`
              : ''
      )
      .join(' ')
    console.log(`  ${m.role}: ${txt.slice(0, 240)}`)
  }
  console.log('=== console errors (' + errors.length + '):')
  for (const e of errors.slice(0, 10)) console.log('  !', e.slice(0, 200))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
