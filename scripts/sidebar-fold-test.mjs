/**
 * Разделы сайдбара сворачиваются — и остаются свёрнутыми.
 *
 * «Недавние» никто не заводит руками: список копится сам и к концу недели
 * закрывает собой всё живое — открытые терминалы и занятых агентов, ради
 * которых сайдбар и открыт. Поэтому раздел сворачивается, помнит своё
 * состояние между запусками и, будучи свёрнутым, говорит, сколько в нём
 * спрятано: иначе он читается как пустое место.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-fold-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const launch = () =>
  electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      NODE_ENV: 'production'
    }
  })

const boot = async (app) => {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  return page
}

/** Заголовок раздела по подписи. */
const head = (page, label) => page.locator('.zy-section-head', { hasText: label }).first()

try {
  console.log('\n[1] Заголовок раздела сворачивает его и говорит, сколько внутри')
  {
    const app = await launch()
    const page = await boot(app)
    await page.evaluate(() => window.__zaryaSplitActive?.('row'))
    await page.waitForTimeout(1000)

    const open = head(page, 'ОТКРЫТЫЕ')
    ok('заголовок раздела — кнопка', (await open.count()) === 1)
    ok(
      'счётчик показывает, сколько строк внутри',
      (await open.locator('.zy-section-count').innerText()).trim() === '1',
      await open.innerText()
    )
    const before = await page.locator('.zy-desk-row').count()
    ok('строки видны до сворачивания', before > 0, before)

    await open.click()
    await page.waitForTimeout(300)
    ok('после клика строк не видно', (await page.locator('.zy-desk-row').count()) === 0)
    ok(
      'а счётчик остался — раздел не выглядит пустым',
      (await open.locator('.zy-section-count').innerText()).trim() === '1'
    )
    ok('стрелка повернулась', (await open.getAttribute('class')).includes('--folded'))

    await open.click()
    await page.waitForTimeout(300)
    ok('повторный клик возвращает строки', (await page.locator('.zy-desk-row').count()) === before)

    // Сворачиваем снова и даём настройкам записаться на диск.
    await open.click()
    await page.waitForTimeout(700)
    await app.close()
  }

  console.log('\n[2] Свёрнутое остаётся свёрнутым после перезапуска')
  {
    const app = await launch()
    const page = await boot(app)
    const open = head(page, 'ОТКРЫТЫЕ')
    ok('раздел по-прежнему свёрнут', (await open.getAttribute('class')).includes('--folded'))
    ok('его строк не видно', (await page.locator('.zy-desk-row').count()) === 0)

    await open.click()
    await page.waitForTimeout(700)
    ok('и разворачивается обратно', (await page.locator('.zy-desk-row').count()) > 0)
    await app.close()
  }

  console.log('\n[3] «Недавние» свёрнуты с самого начала')
  {
    // Свежий профиль: человек ставит Зарю и НЕ должен получать простыню
    // недавнего на весь сайдбар.
    const fresh = mkdtempSync(join(tmpdir(), 'zarya-fold2-'))
    writeFileSync(
      join(fresh, 'settings.json'),
      JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
    )
    const app = await electron.launch({
      args: [join(root, 'out', 'main', 'index.js')],
      env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: fresh, ZARYA_NO_UPDATE_CHECK: '1', NODE_ENV: 'production' }
    })
    const page = await boot(app)
    const folded = await page.evaluate(() => window.__zaryaSettings?.().sessions?.collapsed)
    ok('в настройках свёрнут именно «недавние»', JSON.stringify(folded) === '["recent"]', folded)
    await app.close()
    try {
      rmSync(fresh, { recursive: true, force: true })
    } catch {
      /* временный профиль */
    }
  }
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временный профиль */
  }
}

console.log(`\n[sidebar-fold] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
