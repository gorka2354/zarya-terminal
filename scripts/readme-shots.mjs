/** Clean README screenshots (no personal paths): seeded cosmic feed + launch pad. */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-readme-'))
const out = join(root, 'docs', 'img')
mkdirSync(out, { recursive: true })

// Mirrors what the installed CLI actually resolves today. Kept explicit (not
// fetched) so the shots are reproducible — but it must be refreshed when a new
// model ships, or the README will advertise a model that no longer exists.
const CATALOG = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus', description: 'Opus 5 · 1M', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
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
  //    Панель подписываем тем же путём: в шапке панели и в кнопке проекта иначе
  //    осталась бы настоящая домашняя папка того, кто снимал.
  await page.evaluate(() => {
    const sid = window.__zaryaDumpSessions().activeSessionId
    window.__zaryaRenameForShot?.(sid, 'zarya-web', '~/code/zarya-web')
  })
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

  // 4) Панели: четыре CLI и сайдбар, который их перечисляет. Главное в 0.6 —
  //    и объяснить это словами дороже, чем показать.
  await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: false }))
  await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {})
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(900)
  }
  await page.waitForTimeout(1200)
  // Пути нейтральные: в README не должно быть чужих папок.
  const panes = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves)
  const DEMO = ['zarya-web', 'zarya-api', 'design-system', 'infra']
  await page.evaluate(
    ([list, names]) => {
      list.forEach((sid, i) => {
        window.__zaryaRenameForShot?.(sid, names[i], `~/code/${names[i]}`)
        // Первая панель остаётся с демо-миссией: в кадре должно быть видно и
        // работу агента, и обычные команды рядом.
        if (i > 0) window.__zaryaSeedBlocks?.(sid, 3, 4)
      })
    },
    [panes, DEMO]
  )
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(out, 'panes.png') })
  console.log('shot: docs/img/panes.png')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
