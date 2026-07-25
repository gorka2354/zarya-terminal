/**
 * Proves the launch console shows the CURRENT model catalog with NO live
 * session — the regression behind "Opus 5 вышел, а в Заре его нет".
 *
 * Two things must hold, and both used to fail:
 *   1) opening the console with no conversation still yields a DYNAMIC catalog
 *      (main falls back to a throwaway idle query — see fetchModelsStandalone);
 *   2) the rows carry the freshly resolved version, so a model released after
 *      this build still appears (the binary, not Zarya, owns the catalog).
 *
 * Runs in an isolated ZARYA_USER_DATA, so it never touches a Zarya you have
 * open. Needs a real Claude login (subscription/Max), like lp-live-test.
 *
 *   npm run build && node scripts/qa-model-refresh.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-mrefresh-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
const errors = []
try {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  // Claude mode + open the console. Deliberately NO prompt is ever sent, so any
  // catalog we see had to come from the standalone (session-less) fetch.
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.waitForTimeout(200)
  await page.evaluate(() => window.__zaryaSetUi?.({ launchPadOpen: true }))

  const state = () => page.evaluate(() => window.__zaryaLaunchPadState?.())
  const deadline = Date.now() + 45000
  let st = await state()
  while (Date.now() < deadline && st?.catalogSource !== 'dynamic') {
    await page.waitForTimeout(700)
    st = await state()
  }

  console.log('\nСтрок в каталоге:', st?.rows?.length ?? 0, '· источник:', st?.catalogSource)
  for (const r of st?.rows ?? []) {
    console.log(`  ${r.selected ? '●' : '○'} ${r.title}${r.ctx ? ' [1M]' : ''}  (${r.value})`)
  }

  console.log('\nПроверки:')
  ok('консоль открылась в режиме claude-code', !!st?.open && !!st?.claudeMode, {
    open: st?.open,
    claudeMode: st?.claudeMode
  })
  ok('каталог ДИНАМИЧЕСКИЙ без единого запроса к агенту', st?.catalogSource === 'dynamic', st?.catalogSource)
  ok('каталог непустой', (st?.rows?.length ?? 0) > 0, st?.rows?.length)

  // Every row must be version-qualified from the live catalog (e.g. "Opus 5"),
  // never a bare family name — a bare name means we fell back to the hardcoded
  // list and are guessing.
  const titles = (st?.rows ?? []).map((r) => r.title)
  const versioned = titles.filter((t) => /\d/.test(t))
  ok('строки несут конкретную версию модели', versioned.length === titles.length, titles)

  // The whole point: whatever Opus the installed CLI resolves to today is what
  // shows. We assert it is NOT pinned to the old 4.8 this build once hardcoded.
  const opus = (st?.rows ?? []).find((r) => /^opus/i.test(r.title))
  ok('строка Opus присутствует', !!opus, titles)
  if (opus) {
    console.log(`    → Opus сейчас резолвится в: ${opus.title}`)
    ok('Opus не залипший на 4.8 из старого хардкода', opus.title !== 'Opus 4.8', opus.title)
  }

  ok('без ошибок в консоли рендерера', errors.length === 0, errors.slice(0, 3))
} finally {
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ЕСТЬ ПРОБЛЕМЫ'}: pass=${pass} fail=${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
