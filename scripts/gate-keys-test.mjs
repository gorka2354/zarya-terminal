/**
 * Чужие клавиши не одобряют команды.
 *
 * В активной панели висит гейт: агент просит разрешить запуск инструмента, и
 * Enter означает «выполняй». Одновременно человек делает что-то СВОЁ в другом
 * месте окна — переименовывает сессию в маленьком окне «введите имя».
 *
 * Пока фокус стоял в поле, Enter до диспетчера не доходил. Но стоило перевести
 * фокус на кнопку «Сохранить» (Tab — обычный способ), и одно нажатие делало
 * ДВА дела: сохраняло имя и одобряло гейт. То есть переименование сессии
 * запускало команду, которую человек ещё не прочитал.
 *
 * Прогон гоняется на фейковом драйвере: живой агент здесь не нужен, нужен
 * висящий гейт.
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-gatekeys-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  page.on('console', (m) => m.type() === 'error' && console.log('    [консоль]', m.text()))

  // Гейт: фейковый драйвер поднимает его на слове «tool».
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'codex' }))
  const convId = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  await page.waitForFunction(
    (id) => (window.__zaryaConvById?.(id)?.pendingTools || []).length > 0,
    convId,
    { timeout: 20000 }
  )
  const gate = await page.evaluate((id) => window.__zaryaConvById?.(id)?.pendingTools?.[0], convId)
  ok('гейт висит и ждёт решения', !!gate && !gate.settled, gate)

  // Окно «введите имя» — то самое, через которое переименовывают стол.
  // Внутри — блок, а не выражение: askText возвращает промис, который
  // разрешится только ответом человека, и page.evaluate ждал бы его вечно.
  await page.evaluate(() => {
    void window.__zaryaAskText?.('Имя стола', 'Стол')
  })
  await page.waitForSelector('.zy-ask', { timeout: 5000 })
  ok('окно вопроса открылось', await page.locator('.zy-ask').isVisible())

  // Фокус на кнопке — как после Tab. Именно здесь Enter уходил двоим сразу.
  await page.locator('.zy-ask .zy-btn--accent').focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)

  const after = await page.evaluate((id) => window.__zaryaConvById?.(id)?.pendingTools?.[0], convId)
  ok('гейт НЕ одобрен чужим Enter', !!after && !after.settled, after)
  ok('окно вопроса закрылось', (await page.locator('.zy-ask').count()) === 0)

  // Esc тем же порядком: он отклоняет гейт, и отклонить его случайно так же
  // плохо — человек ждёт ответа агента, а тот получил отказ.
  // Внутри — блок, а не выражение: askText возвращает промис, который
  // разрешится только ответом человека, и page.evaluate ждал бы его вечно.
  await page.evaluate(() => {
    void window.__zaryaAskText?.('Имя стола', 'Стол')
  })
  await page.waitForSelector('.zy-ask', { timeout: 5000 })
  await page.locator('.zy-ask .zy-btn').first().focus()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const afterEsc = await page.evaluate(
    (id) => window.__zaryaConvById?.(id)?.pendingTools?.[0],
    convId
  )
  ok('гейт НЕ отклонён чужим Esc', !!afterEsc && !afterEsc.settled, afterEsc)

  // Контроль: без окна вопроса Enter по-прежнему одобряет — иначе прогон
  // «доказывал» бы работу тем, что клавиши не работают вовсе.
  await page.locator('body').click({ position: { x: 5, y: 400 } })
  await page.waitForTimeout(200)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  const approved = await page.evaluate(
    (id) => window.__zaryaConvById?.(id)?.pendingTools?.[0],
    convId
  )
  ok('без окна вопроса Enter гейт одобряет', !approved || approved.settled, approved)
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временный профиль */
  }
}

console.log(`\n[gate-keys] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
