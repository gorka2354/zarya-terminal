/**
 * Live functional inspection of the native Claude Code driver — a real
 * multi-turn conversation through Zarya: (1) plain reply, (2) follow-up asking
 * it to run a shell command (tests session continuity + tool use), (3) a
 * choice question (widget). Prints the flow and shots key frames.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-insp-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
mkdirSync(join(root, 'shots'), { recursive: true })

const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())
async function settle(page, { wantResult = true, wantQuestion = false } = {}, ms = 70000) {
  const deadline = Date.now() + ms
  let d = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    d = await dump(page)
    if (!d) continue
    if (d.error) break
    if (wantQuestion && (d.pendingTools || []).some((t) => t.kind === 'question')) break
    if (wantResult && !d.streaming && (d.pendingTools || []).length === 0 && d.messages.some((m) => m.role === 'assistant')) break
  }
  return d
}
function printConv(tag, d) {
  console.log(`\n===== ${tag} (streaming=${d?.streaming}, error=${d?.error ?? '—'}) =====`)
  for (const m of d?.messages || []) {
    for (const p of m.content) {
      if (p.type === 'text') console.log(`  ${m.role}: ${p.text.replace(/\n/g, ' ⏎ ').slice(0, 200)}`)
      else if (p.type === 'tool_use') console.log(`  ${m.role}: [tool ${p.name} ${JSON.stringify(p.input).slice(0, 100)}]`)
      else if (p.type === 'tool_result') console.log(`  ${m.role}: [result ${p.isError ? 'ERR ' : ''}${(p.content || '').replace(/\n/g, ' ').slice(0, 90)}]`)
    }
  }
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)

  // Turn 1 — plain conversation.
  await page.evaluate(() => window.__zaryaAskAgent?.('Привет! Ты сейчас работаешь внутри терминала Zarya. Ответь в 2 предложениях: как тебе интерфейс и что видишь вокруг?', 'claude-code'))
  let d = await settle(page)
  printConv('TURN 1 · обычный ответ', d)
  await page.screenshot({ path: join(root, 'shots', 'insp-1.png') })

  // Turn 2 — follow-up in the SAME conversation, asks for a shell command (tests continuity + tools).
  await page.evaluate(() => window.__zaryaFollowUp?.('Запусти команду `node --version` и скажи, какая версия Node здесь.'))
  d = await settle(page)
  printConv('TURN 2 · follow-up + инструмент', d)
  await page.screenshot({ path: join(root, 'shots', 'insp-2.png') })

  // Turn 3 — a choice question (widget).
  await page.evaluate(() => window.__zaryaFollowUp?.('Через AskUserQuestion спроси меня, какую фичу добавить следующей: 3 варианта с описаниями.'))
  d = await settle(page, { wantResult: false, wantQuestion: true })
  const q = (d.pendingTools || []).find((t) => t.kind === 'question')
  console.log('\n===== TURN 3 · вопрос-выбор =====')
  console.log('  widget:', await page.evaluate(() => !!document.querySelector('.zy-cqb')))
  console.log('  question:', JSON.stringify(q?.questions?.[0]?.question))
  console.log('  options:', (q?.questions?.[0]?.options || []).map((o) => o.label).join(' | '))
  await page.screenshot({ path: join(root, 'shots', 'insp-3.png') })

  console.log('\n=== console errors:', errors.length)
  for (const e of errors.slice(0, 8)) console.log('  !', e.slice(0, 160))
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
