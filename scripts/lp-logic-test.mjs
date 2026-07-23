/**
 * LaunchPad logic suite — offline, deterministic (injected catalog, no live
 * session). Covers: Fable present, version parsing, default-row live resolution,
 * current/active markers, effort gating, dynamic-vs-fallback A/B, and boundary
 * cases (empty catalog, unknown pinned model, future model versions).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-lplogic-'))

const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Default (recommended)', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' }
]

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2200)

  const state = () => page.evaluate(() => window.__zaryaLaunchPadState?.())
  // Neuter the live catalog fetch so the fallback path is deterministic when we
  // want it; tests that want the dynamic catalog inject it explicitly.
  await page.evaluate(() => { window.zarya.claudeCode.listModels = async () => [] })
  const reopen = async (cfg) => {
    await page.evaluate((c) => window.__zaryaSetClaudeCfg?.(c.model, c.effort), cfg || { model: '', effort: 'high' })
    await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: false }))
    await page.waitForTimeout(120)
    await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: true }))
    await page.waitForTimeout(200)
  }

  await page.evaluate((cat) => window.__zaryaSetUi?.({ barMode: 'claude-code', claudeModels: cat, claudeStatus: { model: 'claude-fable-5', effort: 'high' } }), CATALOG)

  // ---- 1. DYNAMIC CATALOG: rows, Fable present, versions, default filtered ----
  console.log('\n[1] Динамический каталог — модели, версии, Fable, БЕЗ строки дефолта')
  await reopen({ model: '', effort: 'high' })
  let s = await state()
  const titles = s.rows.map((r) => r.title)
  ok('каталог помечен dynamic', s.catalogSource === 'dynamic', s.catalogSource)
  ok('нет строки "ПО УМОЛЧАНИЮ"', !titles.includes('ПО УМОЛЧАНИЮ'), titles)
  ok('нет отдельной строки value "default"', !s.rows.some((r) => r.value === 'default'), titles)
  ok('ровно 4 модельных строки', s.rows.length === 4, titles)
  ok('Fable присутствует (title "Fable 5")', titles.includes('Fable 5'), titles)
  ok('Opus показан как "Opus 4.8"', titles.includes('Opus 4.8'), titles)
  ok('Sonnet показан как "Sonnet 5"', titles.includes('Sonnet 5'), titles)
  ok('Haiku показан как "Haiku 4.5"', titles.includes('Haiku 4.5'), titles)
  const opusRow = s.rows.find((r) => r.title === 'Opus 4.8')
  ok('Opus имеет бейдж 1M (ctx)', opusRow?.ctx === true, opusRow)
  const haikuRow = s.rows.find((r) => r.title === 'Haiku 4.5')
  ok('Haiku помечен effortOff', haikuRow?.effortOff === true, haikuRow)
  ok('все строки моделей имеют описание', s.rows.every((r) => r.desc && r.desc.length), s.rows.map((r) => r.desc))

  // ---- 2. Empty pin ('') resolves markers onto the RUNNING model's row ----
  console.log('\n[2] Пустой pin ("") подсвечивает реально бегущую модель (Fable)')
  const fableRow = s.rows.find((r) => r.title === 'Fable 5')
  ok('Fable выбрана при claudeModel="" (резолв в running)', fableRow?.selected === true, fableRow)
  ok('Fable активна при claudeModel=""', fableRow?.active === true, fableRow)
  ok('Fable помечена current (реально бежит)', fableRow?.current === true, fableRow)
  ok('другие модели НЕ активны', s.rows.filter((r) => r.title !== 'Fable 5').every((r) => !r.active), s.rows)

  // ---- 3. COMMITTED PIN → active/selected move to the pinned row ----
  console.log('\n[3] Закреплённая модель (pin) → маркеры активной')
  await reopen({ model: 'opus[1m]', effort: 'high' })
  s = await state()
  const oRow = s.rows.find((r) => r.title === 'Opus 4.8')
  ok('Opus активна при pin=opus[1m]', oRow?.active === true, oRow)
  ok('Opus выбрана', oRow?.selected === true, oRow)
  ok('Fable больше не активна (pin=opus)', s.rows.find((r) => r.title === 'Fable 5')?.active === false, s.rows.find((r) => r.title === 'Fable 5'))
  ok('Fable всё ещё current (running)', s.rows.find((r) => r.title === 'Fable 5')?.current === true)

  // ---- 4. EFFORT gating per model ----
  console.log('\n[4] Effort зависит от модели')
  await reopen({ model: 'opus[1m]', effort: 'high' })
  s = await state()
  ok('Opus: 5 уровней effort', s.efforts.length === 5, s.efforts)
  await page.click('[data-model="haiku"]')
  await page.waitForTimeout(150)
  s = await state()
  ok('Haiku: 0 уровней effort', s.efforts.length === 0, s.efforts)
  await page.click('[data-model="sonnet"]')
  await page.waitForTimeout(150)
  s = await state()
  ok('Sonnet: снова 5 уровней', s.efforts.length === 5, s.efforts)

  // ---- 5. EFFORT selection + ultracode override (view) ----
  console.log('\n[5] Выбор effort и ultracode-переключатель')
  await page.click('[data-eff="low"]')
  await page.waitForTimeout(120)
  s = await state()
  ok('effort low выбран', s.effort === 'low' && s.effectiveEffort === 'low', s.effort)
  await page.click('.zy-lp-switch-row')
  await page.waitForTimeout(150)
  s = await state()
  ok('ultracode ON → effectiveEffort xhigh', s.effectiveEffort === 'xhigh' && s.ultracode === true, s)
  ok('ultracode ON → метка содержит ULTRACODE', /ULTRACODE/.test(s.effortValueLabel), s.effortValueLabel)
  ok('превью запуска содержит ULTRACODE', /ULTRACODE/.test(s.launchPreview), s.launchPreview)
  await page.click('.zy-lp-switch-row')
  await page.waitForTimeout(150)
  s = await state()
  ok('ultracode OFF → effectiveEffort снова low', s.effectiveEffort === 'low' && s.ultracode === false, s)

  // ---- 6. A/B: FALLBACK catalog (empty dynamic) still has Fable ----
  console.log('\n[6] A/B: пустой каталог → fallback, Fable всё равно есть (регресс Image #34)')
  await page.evaluate(() => window.__zaryaSetUi?.({ claudeModels: [] }))
  await reopen({ model: '', effort: 'high' })
  s = await state()
  ok('каталог помечен fallback', s.catalogSource === 'fallback', s.catalogSource)
  ok('Fable ЕСТЬ в fallback', s.rows.map((r) => r.title).includes('Fable 5'), s.rows.map((r) => r.title))
  ok('fallback: Opus/Sonnet/Haiku на месте', ['Opus 4.8', 'Sonnet 5', 'Haiku 4.5'].every((t) => s.rows.map((r) => r.title).includes(t)), s.rows.map((r) => r.title))
  ok('fallback: нет строки дефолта', !s.rows.map((r) => r.title).includes('ПО УМОЛЧАНИЮ'))
  ok('fallback: "" резолвит Fable в выбранную', s.rows.find((r) => r.title === 'Fable 5')?.selected === true, s.rows)

  // restore dynamic catalog for the rest
  await page.evaluate((cat) => window.__zaryaSetUi?.({ claudeModels: cat }), CATALOG)

  // ---- 7. BOUNDARY: unknown pinned model gets its own row ----
  console.log('\n[7] Граница: неизвестная закреплённая модель показывается своей строкой')
  await reopen({ model: 'claude-mythos-9-9[1m]', effort: 'high' })
  s = await state()
  const myth = s.rows.find((r) => r.selected)
  ok('неизвестная модель → строка "Mythos 9.9"', myth?.title === 'Mythos 9.9', s.rows.map((r) => r.title))
  ok('неизвестная модель выбрана+активна', myth?.selected && myth?.active, myth)

  // ---- 8. BOUNDARY: future model version parses generically ----
  console.log('\n[8] Граница: будущая версия модели парсится без правок кода')
  const future = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-6-2', displayName: 'Sonnet', description: 'next', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] }]
  await page.evaluate((cat) => window.__zaryaSetUi?.({ claudeModels: cat, claudeStatus: { model: 'claude-sonnet-6-2' } }), future)
  await reopen({ model: '', effort: 'high' })
  s = await state()
  ok('claude-sonnet-6-2 → "Sonnet 6.2"', s.rows.some((r) => r.title === 'Sonnet 6.2'), s.rows.map((r) => r.title))
  ok('"" резолвит running Sonnet 6.2 в выбранную', s.rows.find((r) => r.title === 'Sonnet 6.2')?.selected === true, s.rows)
  ok('нестандартный набор effort (3) уважается', (await (async () => { await page.click('[data-model="sonnet"]'); await page.waitForTimeout(120); return (await state()).efforts })()).length === 3)

  // ---- 9. REGRESSION (fix #2): same-family variants don't double-select ----
  console.log('\n[9] Регресс: sonnet + sonnet[1m] в каталоге → выделяется ровно ОДИН')
  const variants = [
    { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'o', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 's', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet-5[1m]', displayName: 'Sonnet', description: 's1m', supportsEffort: true, supportedEffortLevels: ['high', 'max'] }
  ]
  await page.evaluate((cat) => window.__zaryaSetUi?.({ claudeModels: cat, claudeStatus: { model: 'claude-sonnet-5' } }), variants)
  await reopen({ model: 'sonnet[1m]', effort: 'high' })
  s = await state()
  const selCount = s.rows.filter((r) => r.selected).length
  const actCount = s.rows.filter((r) => r.active).length
  ok('ровно одна строка выбрана', selCount === 1, s.rows.map((r) => [r.value, r.selected]))
  ok('ровно одна строка активна', actCount === 1, s.rows.map((r) => [r.value, r.active]))
  ok('выбран именно sonnet[1m] (exact, не базовый)', s.rows.find((r) => r.selected)?.value === 'sonnet[1m]', s.rows.find((r) => r.selected))
  ok('effort берётся из sonnet[1m] (2 уровня, не 5)', s.efforts.length === 2, s.efforts)

  console.log(`\n[lp-logic] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
