/**
 * Esc над очередью — 1 в 1 как в Claude Code CLI.
 *
 * Семантика взята не из головы, а из транскриптов настоящего CLI
 * (~/.claude/projects/**.jsonl): там очередь ведётся операциями
 * `queue-operation: enqueue | dequeue | remove`, и во ВСЕХ 103 случаях
 * пользовательский `remove` идёт БЕЗ маркера `[Request interrupted by user]`.
 * То есть отмена своей приписки и прерывание хода — разные жесты:
 *
 *   очередь непуста → Esc забирает текст обратно в строку, агент работает дальше;
 *   очереди нет      → Esc прерывает ход.
 *
 * Раньше Заря делала ровно наоборот: Esc прерывал агента, а приписка оставалась
 * в очереди и уходила ему сама сразу после конца хода.
 *
 * Отдельно проверяется то, что CLI НЕ делает: уже отправленное сообщение из
 * ленты не исчезает. В транскрипте CLI оно остаётся вместе с маркером
 * прерывания, значит Claude его видит — спрятать его в ленте значило бы соврать.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-esc-'))
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
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
})

const convById = (page, id) => page.evaluate((i) => window.__zaryaConvById?.(i), id)
const inputValue = (page) =>
  page.evaluate(() => document.querySelector('.zy-agentbar-input')?.value ?? null)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'codex' }))
  await page.waitForTimeout(400)

  console.log('\n[1] Приписка встаёт в очередь, пока агент работает')
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'slow: долгий ход'))
  await page.waitForTimeout(400)
  ok('агент работает', (await convById(page, id))?.streaming === true)

  await page.click('.zy-agentbar-input')
  await page.keyboard.type('добавь ещё тесты')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  let conv = await convById(page, id)
  ok('текст ушёл в очередь', conv?.queued === 'добавь ещё тесты', conv?.queued)
  ok('строка ввода очистилась', (await inputValue(page)) === '', await inputValue(page))
  ok('агент НЕ прерван постановкой в очередь', conv?.streaming === true)

  console.log('\n[2] Esc забирает приписку обратно в строку и НЕ трогает агента')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  conv = await convById(page, id)
  ok('очередь пуста', !conv?.queued, conv?.queued)
  ok('текст вернулся в строку', (await inputValue(page)) === 'добавь ещё тесты', await inputValue(page))
  ok('агент ПРОДОЛЖАЕТ работать', conv?.streaming === true, conv?.streaming)

  console.log('\n[3] Второй Esc — уже прерывание хода')
  // Строку надо очистить: иначе Esc снова окажется «отменой приписки».
  await page.evaluate(() => {
    const el = document.querySelector('.zy-agentbar-input')
    if (el) el.value = ''
  })
  await page.click('.zy-agentbar-input')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  conv = await convById(page, id)
  ok('ход прерван', conv?.streaming === false, conv?.streaming)

  console.log('\n[4] Уже отправленное сообщение из ленты НЕ исчезает')
  // В CLI оно остаётся в транскрипте вместе с [Request interrupted by user],
  // значит модель его видит. Спрятать его в ленте — соврать.
  ok('исходный запрос на месте', (conv?.userTexts ?? []).length >= 1, conv?.userTexts)
  const shown = await page.evaluate(
    () => document.querySelector('.zy-mf-scroll')?.textContent ?? ''
  )
  ok('он же виден в ленте', shown.includes('долгий ход'), shown.slice(0, 120))
  ok('и помечен как прерванный', shown.includes('прервано'), shown.slice(0, 200))

  console.log('\n[5] Приписка не уходит агенту сама после конца хода')
  await page.waitForTimeout(1200)
  conv = await convById(page, id)
  const sentTexts = (conv?.userTexts ?? []).join(' | ')
  ok('отменённой приписки среди отправленного нет', !sentTexts.includes('добавь ещё тесты'), sentTexts)

  console.log(`\n[esc-queue] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
