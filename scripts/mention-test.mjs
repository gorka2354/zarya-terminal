/**
 * Упоминание файла «@» и отказ с объяснением (inc-25) — на живом окне.
 *
 * Проверяем то, чего не докажет юнит: список показывает НАСТОЯЩИЕ файлы папки
 * панели, выбор кладёт путь в строку, а «@» посреди почты список не открывает.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-mention-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-mention-work-'))
mkdirSync(join(work, 'src'), { recursive: true })
writeFileSync(join(work, 'src', 'main.ts'), '// проверка\n', 'utf8')
writeFileSync(join(work, 'readme.md'), '# проверка\n', 'utf8')

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
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    NODE_ENV: 'production'
  }
})

const listed = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-cmdlist-name, .zy-cmd-name')).map(
      (e) => e.textContent || ''
    )
  )

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  /*
   * Работаем в ВИДИМОЙ панели, подменив ей рабочую папку: новая вкладка в
   * прогоне остаётся за кадром, и строка ввода в ней недоступна для клика — то
   * есть проверялся бы не жест, а невидимый элемент.
   */
  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  await page.evaluate(([id, cwd]) => window.__zaryaRenameForShot?.(id, 'проверка', cwd), [sid, work])
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(600)

  console.log('\n[1] «@» открывает список файлов папки панели')
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('посмотри @')
  await page.waitForTimeout(1200)
  const all = await listed(page)
  ok('список открылся', all.length > 0, all.slice(0, 5))
  ok('в нём файлы этой папки', all.some((n) => /readme\.md|src\/main\.ts/.test(n)), all.slice(0, 8))

  console.log('\n[2] Набор сужает список')
  await page.keyboard.type('main')
  await page.waitForTimeout(800)
  const narrowed = await listed(page)
  ok('остался main.ts', narrowed.some((n) => /src\/main\.ts/.test(n)), narrowed)
  if (shots) await page.screenshot({ path: join(shots, 'mention.png') })
  ok('readme отсеян', !narrowed.some((n) => /readme/.test(n)), narrowed)

  console.log('\n[3] Enter подставляет путь в строку')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  const value = await page.inputValue('.zy-agentbar-input')
  ok('путь в строке', /@src\/main\.ts /.test(value), value)
  ok('текст до упоминания цел', value.startsWith('посмотри '), value)
  ok('список закрылся', (await listed(page)).length === 0)

  console.log('\n[4] Почта список не открывает')
  await page.evaluate(() => {
    const el = document.querySelector('.zy-agentbar-input')
    if (el) {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('напиши egor@example')
  await page.waitForTimeout(900)
  ok('списка нет', (await listed(page)).length === 0, await listed(page))

} catch (e) {
  // Без этого `process.exit` в finally гасит вывод необработанной ошибки, и
  // упавший прогон выглядит как прошедший без единой проверки.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // временная папка не удалилась — не повод ронять прогон
  }
  process.exit(fail ? 1 : 0)
}
