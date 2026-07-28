/**
 * Повторное нажатие по кнопке-открывашке должно ЗАКРЫВАТЬ попап.
 *
 * Панель расхода и контекстные меню закрываются по `mousedown` снаружи, а
 * кнопки переключаются по `click`. Порядок событий такой: mousedown закрыл →
 * click тут же открыл заново. Со стороны это «попап не закрывается, только
 * мигает» — ровно то, что видно глазом.
 *
 * Проверяется настоящей мышью Playwright (реальные mousedown/mouseup/click в
 * правильном порядке), а не вызовом обработчика: подделанный click этот баг не
 * воспроизводит вовсе.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-popup-'))
let pass = 0,
  fail = 0
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
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})

const visible = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel)

/** Полный цикл: открыть → закрыть тем же нажатием → открыть снова. */
async function toggleCycle(page, trigger, panel, label) {
  console.log(`\n[${label}]`)
  const btn = await page.$(trigger)
  ok('кнопка на месте', !!btn)
  if (!btn) return

  await btn.click()
  await page.waitForTimeout(400)
  ok('открылось с первого нажатия', await visible(page, panel))

  // Тот самый случай: нажатие по той же кнопке.
  await btn.click()
  await page.waitForTimeout(500)
  ok('ЗАКРЫЛОСЬ повторным нажатием (а не мигнуло)', !(await visible(page, panel)))

  await btn.click()
  await page.waitForTimeout(400)
  ok('открывается снова', await visible(page, panel))

  // Щелчок мимо по-прежнему закрывает — оговорка про якорь не должна этого сломать.
  await page.mouse.click(700, 300)
  await page.waitForTimeout(400)
  ok('щелчок мимо закрывает', !(await visible(page, panel)))
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.waitForTimeout(500)

  await toggleCycle(page, '.zy-agentbar-fuel-main', '.zy-usage-panel', 'Панель расхода')
  await toggleCycle(page, '.zy-mf-head-btn', '.zy-context-menu', 'Меню сессий (↺ в шапке ленты)')

  console.log(`\n[popup-toggle] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
