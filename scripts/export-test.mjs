/**
 * Разговор можно унести (inc-26) — на живом окне.
 *
 * Юнит проверяет текст стенограммы, здесь — что до неё вообще можно добраться:
 * меню в шапке панели, копирование в буфер и запись файла на диск. Диалог
 * сохранения показывает ОС, поэтому в прогоне он подменяется — проверяем, что
 * приложение отдаёт туда правильное имя и правильное содержимое.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-export-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-export-work-'))
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

const menuItems = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-context-item')).map(
      (e) => e.textContent || ''
    )
  )

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // Диалог сохранения принадлежит ОС — в прогоне подменяем его на запись в
  // известный путь: предмет проверки не диалог, а то, что мы в него отдаём.
  const saved = join(work, 'разговор.md')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, saved)

  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'разбери сборку'))
  await page.waitForTimeout(2500)

  console.log('\n[1] В шапке панели есть, чем унести разговор')
  const exportBtn = 'button[title*="Унести разговор"]'
  await page.click(exportBtn)
  await page.waitForTimeout(600)
  const items = await menuItems(page)
  ok('меню открылось', items.length >= 3, items)
  ok('есть сохранение', items.some((i) => /файл/i.test(i)), items)
  ok('есть копирование', items.some((i) => /копировать/i.test(i)), items)
  ok('есть вывод терминала', items.some((i) => /терминал/i.test(i)), items)
  if (shots) await page.screenshot({ path: join(shots, 'export-menu.png') })

  console.log('\n[2] Сохранение кладёт стенограмму на диск')
  await page.click('.zy-context-item:has-text("файл")')
  await page.waitForTimeout(1500)
  ok('файл появился', existsSync(saved), saved)
  const body = existsSync(saved) ? readFileSync(saved, 'utf8') : ''
  ok('в нём слова человека', /разбери сборку/.test(body), body.slice(0, 200))
  ok('и ответ агента', /fake/i.test(body), body.slice(0, 200))
  ok('роли подписаны', /## Человек/.test(body) && /## Агент/.test(body), body.slice(0, 200))

  console.log('\n[3] Копирование кладёт то же самое в буфер')
  await page.click(exportBtn)
  await page.waitForTimeout(500)
  await page.click('.zy-context-item:has-text("Скопировать")')
  await page.waitForTimeout(800)
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  ok('в буфере разговор', /разбери сборку/.test(clip), clip.slice(0, 120))
} catch (e) {
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
