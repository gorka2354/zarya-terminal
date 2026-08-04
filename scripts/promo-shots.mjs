/**
 * Reference shots for the promo film (motion-engine).
 *
 * Not a QA run: nothing here asserts. This exists so the film's UI can be
 * rebuilt component-by-component against the interface Zarya actually ships
 * TODAY, in the default theme, rather than against a screenshot from an era
 * when the accent was still red.
 *
 * The film re-draws the interface in React rather than compositing these PNGs:
 * a raster smears on the first push-in, and a still cannot type. These are the
 * reference, not the footage.
 *
 *   node scripts/promo-shots.mjs [--lang en|ru] [--out shots/promo]
 *
 * Requires a current build (`npm run build`) — it drives out/main/index.js.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const lang = arg('--lang', 'en')
const out = join(root, arg('--out', join('shots', 'promo')), lang)
mkdirSync(out, { recursive: true })

const userData = mkdtempSync(join(tmpdir(), 'zarya-promo-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify(
    {
      appearance: { language: lang, themeId: 'zarya-blue-hour' },
      sessions: { restoreOnLaunch: 'none' }
    },
    null,
    2
  )
)

// Mirrors readme-shots.mjs — kept explicit so the console shows real models.
const CATALOG = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus', description: 'Opus 5 · 1M', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5' }
]

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const shots = []
/** One shot per state. A state that breaks must not take the rest down. */
const shot = async (page, name, prepare) => {
  try {
    if (prepare) await prepare()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(out, `${name}.png`) })
    shots.push(name)
    console.log(`shot: ${name}.png`)
  } catch (e) {
    console.log(`SKIP ${name}: ${e.message.split('\n')[0]}`)
  }
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2800)
  await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {})

  const rename = (sid, title, cwd) =>
    page.evaluate(([s, t, c]) => window.__zaryaRenameForShot?.(s, t, c), [sid, title, cwd])
  const activeId = () => page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)

  // Neutral paths everywhere: a promo must not ship anyone's home folder.
  const sid = await activeId()
  await rename(sid, 'zarya-web', '~/code/zarya-web')

  // 1) The single pane doing real work — agent mid-answer with a pending tool.
  await shot(page, '01-agent-feed', async () => {
    await page.evaluate(() => window.__zaryaSeedMission?.())
    await page.waitForTimeout(900)
  })

  // 2) The model + effort console.
  await shot(page, '02-launchpad', () =>
    page.evaluate(
      (cat) =>
        window.__zaryaSetUi?.({
          barMode: 'claude-code',
          claudeModels: cat,
          claudeStatus: { model: 'claude-fable-5', effort: 'high' },
          launchPadOpen: true
        }),
      CATALOG
    )
  )

  // 3) Command palette.
  await shot(page, '03-palette', async () => {
    await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: false, paletteOpen: true }))
  })
  await page.evaluate(() => window.__zaryaSetUi?.({ paletteOpen: false }))

  // 4) Four panes — the headline feature. Each gets its own blocks so the
  //    frame shows four CLIs working, not one screen copied four times.
  await shot(page, '04-four-panes', async () => {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__zaryaSplitActive('row'))
      await page.waitForTimeout(800)
    }
    await page.waitForTimeout(1000)
    const panes = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves)
    const DEMO = ['zarya-web', 'zarya-api', 'design-system', 'infra']
    await page.evaluate(
      ([list, names]) => {
        list.forEach((s, i) => {
          window.__zaryaRenameForShot?.(s, names[i], `~/code/${names[i]}`)
          if (i > 0) window.__zaryaSeedBlocks?.(s, 3, 4)
        })
      },
      [panes, DEMO]
    )
    await page.waitForTimeout(1200)
  })

  // 5) Settings — the theme gallery. Eleven hours of light in one frame.
  await shot(page, '05-themes', () =>
    page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'appearance' }))
  )

  // 6) Settings — Tools: MCP servers with their real per-request token cost.
  await shot(page, '06-tools', () =>
    page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'tools' }))
  )

  // 7) Settings — Skills: what each skill costs and which never fired (0.7.4).
  await shot(page, '07-skills', () =>
    page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'skills' }))
  )
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false }))

  // 8) The restore marker — the hero beat's literal payload. Zarya replays the
  //    saved scrollback and then says, in the buffer itself, that the shell is
  //    new. The film shows this line; writing it here gets its exact look.
  await shot(page, '08-restored', async () => {
    const cur = await activeId()
    await page.evaluate(
      (s) =>
        window.__zaryaTermWrite?.(
          s,
          '\r\n\x1b[2m╌╌╌╌╌  session restored · new shell  ╌╌╌╌╌\x1b[0m\r\n'
        ),
      cur
    )
    await page.evaluate(() => window.__zaryaSetUi?.({ rawTerminal: true }))
    await page.waitForTimeout(600)
  })
  await page.evaluate(() => window.__zaryaSetUi?.({ rawTerminal: false }))

  // 9) Sessions sidebar — what survived, listed.
  await shot(page, '09-sessions', () =>
    page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: 'sessions' }))
  )

  console.log(`\n${shots.length} shots → ${out}`)
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
