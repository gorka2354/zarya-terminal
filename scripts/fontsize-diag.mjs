/**
 * Diagnostic: does «Размер шрифта» actually reach anything the user looks at?
 *
 * Checks three links of the chain independently, so a break can be located
 * rather than guessed: the settings store, the live xterm options, and the
 * computed CSS of the blocks feed (which is what the main screen renders).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-fontsize-'))
let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  const before = await page.evaluate(() => ({
    setting: window.__zaryaSettings?.().appearance?.fontSize ?? null,
    feedPx: (() => {
      const el = document.querySelector('.zy-mf-scroll')
      return el ? getComputedStyle(el).fontSize : null
    })(),
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--term-font-size') || null
  }))
  console.log('\n[1] Исходное состояние')
  console.log('   ', JSON.stringify(before))

  // Set it the way the settings UI does.
  await page.evaluate(() => window.__zaryaSetFontSize?.(28))
  await page.waitForTimeout(1200)

  const after = await page.evaluate(() => ({
    setting: window.__zaryaSettings?.().appearance?.fontSize ?? null,
    feedPx: (() => {
      const el = document.querySelector('.zy-mf-scroll')
      return el ? getComputedStyle(el).fontSize : null
    })(),
    answerPx: (() => {
      const el = document.querySelector('.zy-mf-answer')
      return el ? getComputedStyle(el).fontSize : null
    })(),
    outPx: (() => {
      const el = document.querySelector('.zy-mf-out') || document.querySelector('.zy-mf-answer')
      return el ? getComputedStyle(el).fontSize : null
    })(),
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--term-font-size') || null,
    xterm: window.__zaryaTermOptions?.() ?? null
  }))
  console.log('\n[2] После установки 28')
  console.log('   ', JSON.stringify(after))

  console.log('\n[3] Вердикт по звеньям цепочки')
  ok('настройка сохранилась в сторе', after.setting === 28, after.setting)
  ok('xterm получил новый fontSize', after.xterm?.fontSize === 28, after.xterm)
  ok('лента «Блоки» изменила размер', after.feedPx !== before.feedPx, {
    before: before.feedPx,
    after: after.feedPx
  })

  console.log(`\n[fontsize-diag] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
