/**
 * LaunchPad design suite — screenshots of every state + layout sanity checks
 * (popover fits the viewport, no horizontal overflow, list scrolls, switch +
 * preview present). Offline with an injected catalog (deterministic).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-lpshots-'))
const shots = join(root, 'shots')
mkdirSync(shots, { recursive: true })
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }

const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Default (recommended)', description: 'Opus 4.8 · 1M', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'Opus 4.8 · 1M', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5' }
]

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2200)
  await page.setViewportSize?.({ width: 1200, height: 820 }).catch(() => {})
  await page.evaluate(() => { window.zarya.claudeCode.listModels = async () => [] })
  await page.evaluate((cat) => window.__zaryaSetUi?.({ barMode: 'claude-code', claudeModels: cat, claudeStatus: { model: 'claude-fable-5', effort: 'high' } }), CATALOG)
  const pad = page.locator('.zy-launchpad')
  const openWith = async (model, effort) => {
    await page.evaluate((c) => window.__zaryaSetClaudeCfg?.(c.model, c.effort), { model, effort })
    await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: false }))
    await page.waitForTimeout(120)
    await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: true }))
    await page.waitForTimeout(300)
  }
  const shot = async (name) => { await pad.screenshot({ path: join(shots, name) }); console.log('  · shot', name) }

  console.log('\n[shots] Состояния пада')
  await openWith('', 'high'); await shot('lp-01-default.png')
  await openWith('opus[1m]', 'high'); await shot('lp-02-opus.png')
  await openWith('claude-fable-5[1m]', 'max'); await shot('lp-03-fable.png')
  await openWith('haiku', 'high'); await shot('lp-04-haiku-noeffort.png')
  // ultracode ON
  await openWith('opus[1m]', 'high')
  await page.click('.zy-lp-switch-row'); await page.waitForTimeout(200)
  await shot('lp-05-ultracode.png')
  // launching countdown
  await openWith('claude-fable-5[1m]', 'max')
  await page.click('.zy-lp-launch'); await page.waitForTimeout(650)
  await shot('lp-06-launching.png')
  await page.waitForTimeout(2800)

  console.log('\n[checks] Раскладка')
  await openWith('opus[1m]', 'high')
  const box = await pad.boundingBox()
  const vp = page.viewportSize() || { width: 1200, height: 820 }
  ok('пад в пределах вьюпорта по X', box && box.x >= 0 && box.x + box.width <= vp.width + 1, box)
  ok('пад в пределах вьюпорта по Y', box && box.y >= 0 && box.y + box.height <= vp.height + 1, box)
  const bodyOverflow = await page.evaluate(() => {
    const b = document.querySelector('.zy-lp-body')
    return b ? { sw: b.scrollWidth, cw: b.clientWidth } : null
  })
  ok('нет горизонтального переполнения тела', bodyOverflow && bodyOverflow.sw <= bodyOverflow.cw + 1, bodyOverflow)
  const listOverflow = await page.evaluate(() => {
    const el = document.querySelector('.zy-lp-models')
    return el ? getComputedStyle(el).overflowY : null
  })
  ok('список моделей скроллится независимо', listOverflow === 'auto' || listOverflow === 'scroll', listOverflow)
  const hasSwitch = await page.locator('.zy-lp-switch-row').count()
  ok('переключатель ULTRACODE присутствует', hasSwitch === 1, hasSwitch)
  const hasPreview = await page.locator('.zy-lp-preview').count()
  ok('превью применения присутствует', hasPreview === 1, hasPreview)
  const hasPoles = await page.locator('.zy-lp-poles').count()
  ok('поля быстрее/умнее присутствуют', hasPoles === 1, hasPoles)
  // idle strip present (rocket collapsed while browsing)
  const idle = await page.locator('.zy-lp-console--idle').count()
  ok('консоль в свёрнутом idle-режиме (ракета не мешает)', idle === 1, idle)

  console.log(`\n[lp-design] PASS ${pass} · FAIL ${fail} · shots → shots/`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
