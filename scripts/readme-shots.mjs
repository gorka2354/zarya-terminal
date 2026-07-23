/** Clean README screenshots (no personal paths): seeded cosmic feed + launch pad. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-readme-'))
const out = join(root, 'docs', 'img')
mkdirSync(out, { recursive: true })

const CATALOG = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'Opus 4.8 · 1M', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5' }
]

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2800)
  await page.setViewportSize?.({ width: 1280, height: 800 }).catch(() => {})

  // 1) Hero — populated cosmic mission feed (seed uses neutral ~/code/zarya-web paths).
  await page.evaluate(() => window.__zaryaSeedMission?.())
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(out, 'hero.png') })
  console.log('shot: docs/img/hero.png')

  // 2) Launch pad — cosmic model + effort console.
  await page.evaluate((cat) => window.__zaryaSetUi?.({ barMode: 'claude-code', claudeModels: cat, claudeStatus: { model: 'claude-fable-5', effort: 'high' }, launchPadOpen: true }), CATALOG)
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(out, 'launchpad.png') })
  console.log('shot: docs/img/launchpad.png')

  // 3) Just the launch pad element, cropped (for a tight secondary image).
  await page.locator('.zy-launchpad').screenshot({ path: join(out, 'launchpad-tight.png') })
  console.log('shot: docs/img/launchpad-tight.png')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
