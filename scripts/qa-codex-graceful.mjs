/**
 * CodexDriver graceful-degradation harness (Ф5): when the codex binary is NOT
 * installed, the engine must (a) be hidden from capabilities via probe, and
 * (b) if a turn is forced anyway, surface a friendly `error` event instead of
 * crashing the app. Launches with a bogus ZARYA_CODEX_BIN to simulate "codex
 * not installed".
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-codex-nx-'))
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
  env: {
    ...process.env,
    ZARYA_USER_DATA: userData,
    NODE_ENV: 'production',
    // A binary that does not exist -> probe fails (ENOENT), start() errors.
    ZARYA_CODEX_BIN: 'zarya-definitely-not-codex-zzz'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Codex не установлен → probe прячет движок из capabilities')
  const caps = await page.evaluate(async () => window.zarya.agent.capabilities())
  ok('codex ОТСУТСТВУЕТ в caps (probe=false, нет мёртвого чипа)', !caps.codex, Object.keys(caps))
  ok('claude-code всё ещё доступен', !!caps['claude-code'])

  console.log('\n[2] Форс-старт на codex → дружелюбный error, приложение НЕ падает')
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  let convErr = null
  const dl = Date.now() + 12000
  while (Date.now() < dl) {
    await page.waitForTimeout(200)
    const c = await page.evaluate((i) => window.__zaryaConvById?.(i), id)
    if (c && !c.streaming && c.error) {
      convErr = c.error
      break
    }
    if (c && !c.streaming && !c.error && c.text) break
  }
  ok('беседа получила error (не зависла)', !!convErr, convErr)
  ok('текст ошибки упоминает установку codex', /codex|устано|npm/i.test(convErr || ''), convErr)

  // The app must still be alive and responsive after the failed engine.
  const alive = await page.evaluate(() => !!window.zarya && typeof window.zarya.agent?.capabilities === 'function')
  ok('приложение живо и отзывчиво после сбоя движка', alive === true)

  console.log(`\n[qa-codex-graceful] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
