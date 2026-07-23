/**
 * LaunchPad catalog persistence — the actual fix for "Fable missing on cold
 * start". Run 1 opens a live session (catalog fetched) then closes; Run 2 reuses
 * the same user-data dir and asserts the catalog (incl. Fable) is restored on
 * boot WITHOUT any live session — the pad shows every model immediately.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-lppersist-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }
const launch = () => electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })

try {
  // ---------- RUN 1: warm the catalog from a live session ----------
  console.log('\n[RUN 1] Живая сессия прогревает каталог, затем сохраняем')
  {
    const app = await launch()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2200)
    await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
    await page.evaluate(() => window.__zaryaAskAgent?.('ответь одним словом: ок', 'claude-code'))
    const dl = Date.now() + 45000
    let models = []
    while (Date.now() < dl) {
      await page.waitForTimeout(1500)
      models = await page.evaluate(() => window.__zaryaClaudeModels?.()) || []
      const conv = await page.evaluate(() => window.__zaryaDumpConv?.())
      if (models.length && conv && !conv.streaming && conv.messages?.some((m) => m.role === 'assistant')) break
    }
    ok('каталог получен из живой сессии', models.length >= 4, models.map((m) => m.value))
    ok('Fable есть в живом каталоге', models.some((m) => /fable/i.test(m.value)), models.map((m) => m.value))
    await page.waitForTimeout(2000) // let the 800ms debounced save flush
    await app.close()
  }

  // ---------- RUN 2: cold start, NO session — catalog restored ----------
  console.log('\n[RUN 2] Холодный старт БЕЗ сессии — каталог восстановлен, Fable виден')
  {
    const app = await launch()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2600) // allow aiStore.hydrate() to run
    // Neuter any live fetch so we prove the restore, not a fresh fetch.
    await page.evaluate(() => { window.zarya.claudeCode.listModels = async () => [] })
    const restored = await page.evaluate(() => window.__zaryaClaudeModels?.()) || []
    ok('каталог восстановлен из диска без сессии', restored.length >= 4, restored.map((m) => m.value))
    ok('Fable восстановлен', restored.some((m) => /fable/i.test(m.value)), restored.map((m) => m.value))
    // Open the pad and confirm the view shows Fable + versions with no session.
    await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code', launchPadOpen: true }))
    await page.waitForTimeout(400)
    const s = await page.evaluate(() => window.__zaryaLaunchPadState?.())
    const titles = (s?.rows || []).map((r) => r.title)
    ok('пад на холодном старте помечен dynamic (не fallback)', s?.catalogSource === 'dynamic', s?.catalogSource)
    ok('пад показывает Fable 5 без сессии', titles.includes('Fable 5'), titles)
    ok('пад показывает версии (Opus 4.8 / Sonnet 5)', ['Opus 4.8', 'Sonnet 5'].every((t) => titles.includes(t)), titles)
    await app.close()
  }

  console.log(`\n[lp-persist] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
