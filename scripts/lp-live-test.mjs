/**
 * LaunchPad live suite — needs a real Claude Code session (Max auth). Proves the
 * picker's actions actually reach the SDK: reads driver.debugFlags() (the exact
 * applyFlagSettings/setModel payloads) after ПУСК. Covers model apply, effort
 * apply, ultracode ON/OFF A/B, the double-ПУСК race guard, and an end-to-end
 * model switch verified by the next turn's real model.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-lplive-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
const errors = []
try {
  const page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2200)

  const state = () => page.evaluate(() => window.__zaryaLaunchPadState?.())
  const flags = () => page.evaluate(() => window.zarya.claudeCode.debugFlags())
  const status = () => page.evaluate(() => window.__zaryaClaudeStatus?.())
  // debugFlags now records only AFTER the SDK accepts the apply (async), so poll
  // until the expected keys land (proving a real apply, not mere intent).
  const waitFlags = async (pred, ms = 8000) => {
    const dl = Date.now() + ms
    let f = {}
    while (Date.now() < dl) {
      f = (await flags()) || {}
      if (pred(f)) return f
      await page.waitForTimeout(400)
    }
    return f
  }
  const openPad = async () => { await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: false })); await page.waitForTimeout(120); await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: true })); await page.waitForTimeout(250) }

  // Start a live session so the catalog + a live query exist.
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: ок', 'claude-code'))
  const dl = Date.now() + 45000
  let ready = false
  while (Date.now() < dl) {
    await page.waitForTimeout(1500)
    const m = await page.evaluate(() => window.__zaryaClaudeModels?.())
    const st = await status()
    if (m && m.length && st?.model) { ready = true; break }
  }
  console.log('\n[0] Живая сессия')
  ok('каталог + init получены (сессия живая)', ready)

  // ---- 1. MODEL + EFFORT apply (ultracode off) ----
  console.log('\n[1] ПУСК с моделью+effort (ultracode выкл) → реально ушло в SDK')
  await openPad()
  await page.click('[data-model="opus[1m]"]')
  await page.waitForTimeout(120)
  await page.click('[data-eff="medium"]')
  await page.waitForTimeout(120)
  let s = await state()
  ok('ultracode выключен перед пуском', s.ultracode === false)
  await page.click('.zy-lp-launch')
  let f = await waitFlags((x) => x.model === 'opus[1m]' && x.effortLevel === 'medium')
  ok('SDK принял модель opus[1m]', f.model === 'opus[1m]', f)
  ok('SDK принял effortLevel medium', f.effortLevel === 'medium', f)
  ok('ultracode=false реально применён к SDK', f.ultracode === false, f)
  const stA = await status()
  ok('claudeStatus.model оптимистично = opus[1m]', stA?.model === 'opus[1m]', stA)

  // ---- 2. A/B: ULTRACODE ON ----
  console.log('\n[2] A/B: ultracode ВКЛ → SDK получает ultracode:true + xhigh')
  await page.waitForTimeout(3200) // let the pad auto-close after the countdown
  await openPad()
  await page.click('.zy-lp-switch-row')
  await page.waitForTimeout(150)
  s = await state()
  ok('переключатель ultracode включён (view)', s.ultracode === true && s.effectiveEffort === 'xhigh', s)
  await page.click('.zy-lp-launch')
  f = await waitFlags((x) => x.ultracode === true && x.effortLevel === 'xhigh')
  ok('SDK принял ultracode:true', f.ultracode === true, f)
  ok('SDK принял effortLevel xhigh', f.effortLevel === 'xhigh', f)
  await page.waitForTimeout(3200)
  await openPad()
  s = await state()
  ok('ultracode сохранился в uiStore (виден после переоткрытия)', s.ultracode === true, s)

  // ---- 3. A/B: ULTRACODE OFF again → effort restored, ultracode:false ----
  console.log('\n[3] A/B: ultracode ВЫКЛ обратно → effort снова управляем')
  await page.click('.zy-lp-switch-row')
  await page.waitForTimeout(150)
  await page.click('[data-eff="high"]')
  await page.waitForTimeout(120)
  await page.click('.zy-lp-launch')
  f = await waitFlags((x) => x.ultracode === false && x.effortLevel === 'high')
  ok('SDK принял ultracode:false', f.ultracode === false, f)
  ok('SDK принял effortLevel high', f.effortLevel === 'high', f)

  // ---- 4. BOUNDARY: double ПУСК race guard ----
  console.log('\n[4] Граница: двойной быстрый ПУСК не запускает дважды')
  await page.waitForTimeout(3200)
  await openPad()
  await page.click('[data-model="sonnet"]')
  await page.waitForTimeout(120)
  const btn = page.locator('.zy-lp-launch')
  await btn.click()
  const disabledAfterFirst = await btn.isDisabled()
  await btn.click({ force: true }).catch(() => {})
  ok('кнопка ПУСК блокируется после первого клика (guard)', disabledAfterFirst === true)
  f = await waitFlags((x) => x.model === 'sonnet')
  ok('после guard применилась выбранная модель sonnet', f.model === 'sonnet', f)

  // ---- 5. END-TO-END: switched model actually runs next turn ----
  console.log('\n[5] End-to-end: переключённая модель реально бежит на следующем ходу')
  await page.waitForTimeout(3200)
  await openPad()
  await page.click('[data-model="opus[1m]"]')
  await page.waitForTimeout(120)
  await page.click('.zy-lp-launch')
  await page.waitForTimeout(3300) // apply + pad closes
  await page.evaluate(() => window.__zaryaFollowUp?.('ответь одним словом: готово'))
  const dl2 = Date.now() + 40000
  let ran = ''
  while (Date.now() < dl2) {
    await page.waitForTimeout(1500)
    const st = await status()
    if (st?.model) ran = st.model
    const conv = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (conv && !conv.streaming && conv.messages?.some((m) => m.role === 'assistant')) break
  }
  ok('после переключения реально бежит Opus (claudeStatus.model)', /opus/i.test(ran), ran)

  console.log('\n[6] Ошибки консоли')
  const realErrors = errors.filter((e) => !/DevTools|Autofill|Electron Security|source map|font/i.test(e))
  ok('нет ошибок в консоли', realErrors.length === 0, realErrors.slice(0, 4))

  console.log(`\n[lp-live] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
