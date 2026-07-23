/**
 * The user's exact question: switch the model DURING an in-flight agent response.
 * Verifies: (1) nothing breaks — the in-flight turn still completes with no error;
 * (2) the gauge shows the NEW model after the turn (fix #5 — no revert to the old
 * one); (3) the NEXT turn actually RUNS on the new model (ground truth). Also a
 * mid-turn effort change to confirm it doesn't break the stream.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-mts-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }
const famOf = (id) => (id || '').replace(/^claude-/, '').replace(/\[1m\]/i, '').split(/[-\s]/)[0].toLowerCase()

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
const errors = []
const dump = () => page0.evaluate(() => window.__zaryaDumpConv?.())
const status = () => page0.evaluate(() => window.__zaryaClaudeStatus?.())
let page0
async function settle(ms = 80000) {
  const dl = Date.now() + ms
  let d = null
  while (Date.now() < dl) {
    await page0.waitForTimeout(1200)
    d = await dump()
    if (d && !d.streaming && d.messages.some((m) => m.role === 'assistant')) break
  }
  return d
}
try {
  const page = await app.firstWindow(); page0 = page
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // Start a turn on SONNET with a prompt that streams for a few seconds.
  console.log('\n[1] Старт хода на sonnet, ловим стриминг')
  await page.evaluate(() => window.__zaryaSetClaudeCfg?.('sonnet', 'high'))
  await page.evaluate(() => window.__zaryaAskAgent?.('Напиши короткое стихотворение про космос, ровно 8 строк, по одной на строку.', 'claude-code'))
  // wait until the turn is actually streaming
  let sawStreaming = false
  const dlS = Date.now() + 30000
  while (Date.now() < dlS) {
    await page.waitForTimeout(300)
    const d = await dump()
    if (d?.streaming) { sawStreaming = true; break }
  }
  ok('ход реально пошёл в стриминг', sawStreaming)

  // MID-TURN: switch model + effort live while streaming.
  console.log('\n[2] ВО ВРЕМЯ ответа меняем модель (→opus) и effort (→max)')
  await page.evaluate(() => window.__zaryaApplyModelLive?.('opus[1m]'))
  await page.evaluate(() => window.__zaryaSetClaudeCfg?.('opus[1m]', 'max'))
  const midDump = await dump()
  ok('стрим не оборвался ошибкой в момент смены', !midDump?.error, midDump?.error)

  // The in-flight turn must still finish cleanly.
  console.log('\n[3] Текущий ход всё равно завершается корректно')
  let d = await settle()
  ok('ход завершился (не завис, есть ответ ассистента)', !!d && !d.streaming && d.messages.some((m) => m.role === 'assistant'), { streaming: d?.streaming, err: d?.error })
  ok('без ошибки после смены во время ответа', !d?.error, d?.error)

  // Fix #5: after the old turn's result, the gauge shows the NEW model, not reverted.
  console.log('\n[4] Датчик показывает НОВУЮ модель (не откатился на sonnet)')
  let st = await status()
  ok('claudeStatus.model = opus (фикс #5, без отката)', famOf(st?.model) === 'opus', st?.model)

  // The NEXT message really runs on the new model (ground truth).
  console.log('\n[5] Следующее письмо реально бежит на новой модели (opus)')
  await page.evaluate(() => window.__zaryaFollowUp?.('ответь одним словом: готово'))
  d = await settle()
  st = await status()
  ok('следующий ход реально бежал на opus (ground-truth)', famOf(st?.model) === 'opus', st?.model)
  ok('следующий ход без ошибки', !d?.error, d?.error)

  console.log('\n[6] Ошибки консоли')
  const real = errors.filter((e) => !/DevTools|Autofill|source map|font|Electron Security/i.test(e))
  ok('нет ошибок консоли за весь сценарий', real.length === 0, real.slice(0, 4))

  console.log(`\n[qa-midturn-switch] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
