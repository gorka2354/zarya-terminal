/**
 * Coverage-independent visual QA harness.
 *
 * Launches Zarya in an ISOLATED throwaway instance (its own userData, no
 * single-instance lock, no user sessions) via Playwright's Electron driver and
 * captures the renderer's real pixels with page.screenshot() / capturePage().
 * Because it reads the renderer surface (not the screen), it works regardless
 * of what covers the window, which monitor it's on, or whether it's focused.
 *
 * Prereq: `npm run build` (needs out/main/index.js).
 *
 * Usage:
 *   node scripts/shoot.mjs --theme zarya-cosmos --out shots/cosmos.png
 *   node scripts/shoot.mjs --theme zarya-plakat --rocket --out shots/rocket.png
 *
 * Flags:
 *   --theme <id>   force a theme before capturing
 *   --rocket       fire the launchRocket() overlay and capture mid-animation
 *   --out <path>   output PNG (default shots/shot.png)
 *   --wait <ms>    extra settle time before capture (default 1500)
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const root = process.cwd()

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const theme = arg('theme', null)
const rocket = !!arg('rocket', false)
const out = resolve(String(arg('out', 'shots/shot.png')))
const wait = Number(arg('wait', 1500))

const userData = mkdtempSync(join(tmpdir(), 'zarya-shot-'))
// Seed an isolated settings file so the instance boots on the requested theme
// with no restored sessions.
if (theme) {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ appearance: { themeId: theme }, sessions: { restoreOnLaunch: 'none' } }, null, 2)
  )
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Let the app boot (spawn a shell, apply theme, render chrome).
  await page.waitForTimeout(wait)

  if (arg('seed', false)) {
    // Populate the mission feed with the design's sample mission (2 shell
    // blocks + an agent turn with a patch + tool-call card).
    await page.evaluate(() => window.__zaryaSeedMission?.())
    await page.waitForTimeout(500)
  }

  const ui = arg('ui', null) // e.g. --ui launchPadOpen
  if (ui) {
    await page.evaluate((k) => window.__zaryaSetUi?.({ [k]: true }), String(ui))
    await page.waitForTimeout(500)
  }

  if (rocket) {
    // Fire the launch overlay via the test hook, then grab a mid-liftoff frame.
    await page.evaluate(() => window.__zaryaLaunchRocket?.({ label: 'claude-fable-5' }))
    await page.waitForTimeout(1050)
  }

  mkdirSync(dirname(out), { recursive: true })
  await page.screenshot({ path: out })
  console.log('shot saved:', out)
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    // temp dir cleanup best-effort
  }
}
