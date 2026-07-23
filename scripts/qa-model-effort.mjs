/**
 * Deep model + effort verification (Claude API, sequential — bounded to protect
 * the shared 5h/7d limit).
 *  - per model: GROUND TRUTH — fresh conversation → the model that ACTUALLY ran
 *    (result.models → claudeStatus.model) matches the requested family;
 *  - per effort: CONFIG ROUND-TRIP — the requested effort reaches the driver's
 *    live session (settings → opts.effort → init.effort). NOTE: the SDK does not
 *    echo its effective reasoning effort back, so whether the model actually
 *    reasons at that level is server-side and NOT client-observable; this only
 *    proves the value is plumbed end-to-end to the session, not honoured. (The
 *    live applyFlagSettings accept-check lives in lp-live-test.mjs.)
 *  - a live mid-session model switch takes effect on the next turn.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-qame-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }
const famOf = (id) => (id || '').replace(/^claude-/, '').replace(/\[1m\]/i, '').split(/[-\s]/)[0].toLowerCase()

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
const errors = []
async function settle(page, ms = 75000) {
  const dl = Date.now() + ms
  let d = null
  while (Date.now() < dl) {
    await page.waitForTimeout(1500)
    d = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (d && !d.streaming && d.messages.some((m) => m.role === 'assistant')) break
  }
  return d
}
const status = (page) => page.evaluate(() => window.__zaryaClaudeStatus?.())

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // ---- MODEL matrix: fresh conv per model, verify the model that RAN ----
  console.log('\n[A] Матрица моделей — реально работавшая модель (ground-truth)')
  const models = [
    { set: 'opus[1m]', fam: 'opus' },
    { set: 'claude-fable-5[1m]', fam: 'fable' },
    { set: 'sonnet', fam: 'sonnet' },
    { set: 'haiku', fam: 'haiku' }
  ]
  for (const m of models) {
    await page.evaluate((v) => window.__zaryaSetClaudeCfg?.(v, 'high'), m.set)
    await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: привет', 'claude-code'))
    await settle(page)
    const st = await status(page)
    ok(`модель "${m.set}" → реально бежала ${m.fam} (${st?.model})`, famOf(st?.model) === m.fam, st?.model)
  }
  // default '' — resolves to the account model (record which)
  await page.evaluate(() => window.__zaryaSetClaudeCfg?.('', 'high'))
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: привет', 'claude-code'))
  await settle(page)
  let st = await status(page)
  ok('дефолт "" резолвится в известную модель', ['opus', 'fable', 'sonnet', 'haiku'].includes(famOf(st?.model)), st?.model)
  console.log(`     (дефолт аккаунта = ${famOf(st?.model)} / ${st?.model})`)

  // ---- EFFORT matrix: config round-trips to the live session (NOT SDK-effective) ----
  console.log('\n[B] Матрица effort — конфиг доезжает до сессии (round-trip, не SDK-эффект)')
  for (const eff of ['low', 'medium', 'high', 'xhigh', 'max']) {
    await page.evaluate((e) => window.__zaryaSetClaudeCfg?.('sonnet', e), eff)
    await page.evaluate(() => window.__zaryaAskAgent?.('ответь: ок', 'claude-code'))
    await settle(page)
    st = await status(page)
    ok(`effort "${eff}" доехал до сессии (init.effort)`, st?.effort === eff, st?.effort)
  }

  // ---- LIVE mid-session model switch ----
  console.log('\n[C] Live-переключение модели в той же беседе')
  await page.evaluate(() => window.__zaryaSetClaudeCfg?.('sonnet', 'high'))
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: раз', 'claude-code'))
  await settle(page)
  st = await status(page)
  ok('turn 1 бежит на sonnet', famOf(st?.model) === 'sonnet', st?.model)
  await page.evaluate(() => window.__zaryaApplyModelLive?.('opus[1m]'))
  await page.evaluate(() => window.__zaryaFollowUp?.('ответь одним словом: два'))
  await settle(page)
  st = await status(page)
  ok('turn 2 после live-switch реально бежит на opus', famOf(st?.model) === 'opus', st?.model)

  console.log('\n[D] Ошибки консоли')
  const real = errors.filter((e) => !/DevTools|Autofill|source map|font|Electron Security/i.test(e))
  ok('нет ошибок консоли за весь прогон', real.length === 0, real.slice(0, 4))

  console.log(`\n[qa-model-effort] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
