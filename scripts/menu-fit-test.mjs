/**
 * Выпадающее меню обязано помещаться в окно.
 *
 * Список прошлых сессий Claude для папки бывает в два десятка строк, каждая — с
 * длинным заголовком. У `.zy-context-menu` не было ни потолка высоты, ни
 * прокрутки, а позиция клампилась только сверху: при высоте больше окна
 * `innerHeight - height - 8` уходило в минус, меню выезжало за ВЕРХНЮЮ кромку, и
 * первые пункты становились недоступны вообще — ни мышью, ни прокруткой.
 *
 * Проверяем геометрию, а не «выглядит нормально»: меню целиком внутри окна и,
 * если строк много, прокручивается.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-menu-'))
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
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

/** Геометрия меню относительно окна. */
const geom = (page) =>
  page.evaluate(() => {
    const m = document.querySelector('.zy-context-menu')
    if (!m) return null
    const r = m.getBoundingClientRect()
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      left: Math.round(r.left),
      right: Math.round(r.right),
      winH: window.innerHeight,
      winW: window.innerWidth,
      items: m.querySelectorAll('.zy-context-item').length,
      scrollable: m.scrollHeight > m.clientHeight + 1,
      // Высота одного пункта: если заголовок переносится, пункты становятся
      // трёхстрочными и двадцать таких уже выше экрана.
      itemH: Math.round(m.querySelector('.zy-context-item')?.getBoundingClientRect().height ?? 0)
    }
  })

const openMenu = async (page, items) =>
  page.evaluate((n) => {
    // Меню рисуется общим компонентом; открываем его напрямую с нужным числом
    // пунктов — так проверка не зависит от того, сколько сессий на машине.
    window.__zaryaTestMenu?.(
      Array.from({ length: n }, (_, i) => ({
        label: `Review multiselect handler security changes ${i + 1} — длинный заголовок сессии`,
        hint: '26.07.2026'
      }))
    )
  }, items)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  for (const [n, note] of [
    [3, 'короткий список'],
    [25, 'двадцать пять сессий — как на скриншоте'],
    [80, 'заведомо больше экрана']
  ]) {
    console.log(`\n[${n} пунктов] ${note}`)
    await openMenu(page, n)
    await page.waitForTimeout(350)
    const g = await geom(page)
    ok('меню открылось', !!g, g)
    if (!g) continue
    ok('верх не за кромкой окна', g.top >= 0, g)
    ok('низ не за кромкой окна', g.bottom <= g.winH, g)
    ok('левый край внутри окна', g.left >= 0, g)
    ok('правый край внутри окна', g.right <= g.winW, g)
    ok('пункт в одну строку', g.itemH > 0 && g.itemH < 44, g.itemH)
    if (n > 20) ok('длинный список прокручивается', g.scrollable === true, g)
    if (shots && n === 25) await page.screenshot({ path: join(shots, 'menu-25.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }

  console.log('\n[низ экрана] меню, открытое у нижней кромки, не вылезает вниз')
  await page.evaluate(() =>
    window.__zaryaTestMenu?.(
      Array.from({ length: 20 }, (_, i) => ({ label: `Пункт ${i + 1}` })),
      { x: 40, y: window.innerHeight - 10 }
    )
  )
  await page.waitForTimeout(350)
  const bottom = await geom(page)
  ok('верх внутри окна', bottom && bottom.top >= 0, bottom)
  ok('низ внутри окна', bottom && bottom.bottom <= bottom.winH, bottom)

  console.log('\n[читаемость] обрезанный пункт можно прочитать наведением')
  await openMenu(page, 5)
  await page.waitForTimeout(300)
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-context-item > span:first-child')].map((s) => ({
      title: s.getAttribute('title'),
      full: s.textContent,
      truncated: s.scrollWidth > s.clientWidth + 1
    }))
  )
  ok('у пункта есть подсказка с полным текстом', titles.every((t) => t.title === t.full), titles[0])
  ok('длинный заголовок обрезан — значит подсказка и нужна', titles.some((t) => t.truncated), titles[0])

  console.log('\n[Escape при фокусе в терминале] меню всё равно закрывается')
  // xterm вешает свой keydown на textarea в фазе захвата и глушит Escape:
  // слушатель на window в фазе всплытия события не видел вовсе.
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus())
  await page.waitForTimeout(200)
  ok('фокус действительно в терминале', await page.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea') === true
  ))
  ok('меню открыто', !!(await geom(page)))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
  ok('закрылось, хотя фокус был в терминале', (await geom(page)) === null)

  console.log(`\n[menu-fit] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
