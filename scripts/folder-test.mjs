/**
 * Проекты: строка в шапке открывает терминал в своей папке.
 *
 * Прогон переписан вслед за интерфейсом. Раньше проекты жили в ▾-меню сайдбара,
 * и он проверял именно его; после того как проекты свели в ОДНО место — кнопку
 * с папкой в шапке, — прогон продолжал ждать пункт, которого больше нет. Красный
 * прогон, проверяющий вчерашний интерфейс, хуже отсутствующего: он приучает не
 * смотреть на результат.
 *
 * Проверяется то, ради чего эта строка есть: открылся ли терминал ИМЕННО в
 * папке проекта, и видно ли, что проект уже открыт (точка перед именем).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-fld-'))
// Своя папка, а не Рабочий стол: у прогона не должно быть мнения о том, что
// лежит на машине человека, и он не должен зависеть от языка её имени.
const projectDir = mkdtempSync(join(tmpdir(), 'zarya-project-'))
const projectName = basename(projectDir)
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify(
    {
      bookmarks: [projectDir],
      appearance: { language: 'ru' },
      sessions: { restoreOnLaunch: 'none' }
    },
    null,
    2
  )
)

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
  env: {
    ...process.env,
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})
const errors = []
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)

  // Проекты живут в шапке — там же, где написано, в какой папке идёт работа.
  await page.locator('.zy-titlebar-proj').click()
  await page.waitForTimeout(400)
  const items = await page.locator('.zy-context-item').allTextContents()
  console.log('  пункты меню:', JSON.stringify(items))
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'folder-menu.png') })

  ok('добавление проекта предлагается первым', items[0]?.includes('Добавить проект'), items[0])
  ok('проект из настроек виден в списке', items.some((x) => x.includes(projectName)), items)
  ok(
    'пока проект не открыт — точки перед именем нет',
    !items.some((x) => x.includes('●') && x.includes(projectName)),
    items
  )

  await page.locator('.zy-context-item', { hasText: projectName }).first().click()
  await page.waitForTimeout(2000)
  const s = await page.evaluate(() => window.__zaryaDumpSessions?.())
  const cwds = s.sessions.map((x) => x.cwd)
  console.log('  каталоги сессий:', JSON.stringify(cwds))
  ok(
    'терминал открылся именно в папке проекта',
    cwds.some((c) => (c || '').toLowerCase().includes(projectName.toLowerCase())),
    cwds
  )

  // Точка «открыт сейчас» — единственное, что отличает список папок от списка
  // происходящего. Она сравнивает пути по смыслу, а не побайтово: C:/x и C:\x —
  // одна и та же папка, и когда-то именно на этом точка не загоралась.
  await page.locator('.zy-titlebar-proj').click()
  await page.waitForTimeout(400)
  const after = await page.locator('.zy-context-item').allTextContents()
  ok(
    'открытый проект помечен точкой',
    after.some((x) => x.includes('●') && x.includes(projectName)),
    after
  )
  await page.keyboard.press('Escape')

  ok('консоль чистая', errors.length === 0, errors.slice(0, 3))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  } catch {
    /* временные папки */
  }
}

console.log(`\n[folder] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
