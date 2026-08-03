/**
 * Отмена отправленного — на НАСТОЯЩЕМ Claude Code (нужна живая авторизация Max).
 *
 * Фейковый драйвер (esc-rewind-test.mjs) доказывает нашу половину: рендерер
 * убирает сообщение, запоминает точку ветки и передаёт её следующим ходом. Чего
 * он доказать не может — что `resumeSessionAt` + `forkSession` в Agent SDK и
 * правда обрезают историю. Проверяется единственным честным способом: агенту
 * дают слово, которое он ДОЛЖЕН помнить, и слово, которое он помнить НЕ должен,
 * а потом спрашивают, что он знает.
 *
 * Стоит два коротких хода подписки. Не входит в обычный прогон — запускать
 * руками: node scripts/esc-rewind-live.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-rewind-live-'))
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
  env: { ...process.env, ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production', ZARYA_DEBUG: '1' }
})
app.process().stderr?.on('data', (b) => {
  const t = String(b)
  if (t.includes('rewind') || t.includes('ids')) console.log('    [main]', t.trim())
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await page.waitForTimeout(400)

  const conv = (id) => page.evaluate((i) => window.__zaryaConvById?.(i), id)
  const inputValue = () =>
    page.evaluate(() => document.querySelector('.zy-agentbar-input')?.value ?? null)
  const clearInput = async () => {
    await page.click('.zy-agentbar-input')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
  }
  /** Ждать состояния беседы, а не «столько-то миллисекунд»: живой агент неспешен. */
  const waitConv = async (id, pred, ms = 90_000) => {
    const dl = Date.now() + ms
    let c = null
    while (Date.now() < dl) {
      c = await conv(id)
      if (c && pred(c)) return c
      await page.waitForTimeout(500)
    }
    return c
  }

  console.log('\n[1] Ход, который агент ДОЛЖЕН запомнить')
  const id = await page.evaluate(() =>
    window.__zaryaStartAgent?.(
      'claude-code',
      'Запомни кодовое слово КЕДР. Подтверди коротко, что запомнил.'
    )
  )
  await waitConv(id, (x) => x.streaming === true, 20_000)
  let c = await waitConv(id, (x) => x.streaming === false)
  ok('агент ответил', c?.streaming === false && !!c?.text, c?.text?.slice(0, 120))
  const sessionBefore = c?.sessionId
  ok('id сессии получен', !!sessionBefore, sessionBefore)

  console.log('\n[2] Ход, который отменяем ДО ответа')
  await clearInput()
  await page.keyboard.type('Запомни второе кодовое слово ЛИПА. Подтверди коротко.')
  await page.keyboard.press('Enter')
  // Esc — при первой же возможности: пока агент только думает. Ждать «немного»
  // нельзя, иначе тест начнёт гоняться с первым токеном.
  c = await waitConv(id, (x) => x.streaming === true, 15_000)
  ok('ход пошёл', c?.streaming === true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  c = await conv(id)
  ok('ЛИПА исчезла из ленты', !(c?.text ?? '').includes('ЛИПА'), c?.text?.slice(-200))
  ok('текст вернулся в строку ввода', (await inputValue())?.includes('ЛИПА'), await inputValue())
  ok('точка отмотки записана', !!c?.resumeAt, c?.resumeAt)
  ok('ветка от прежней сессии', c?.sessionId === sessionBefore, {
    was: sessionBefore,
    now: c?.sessionId
  })
  ok('КЕДР в ленте остался', (c?.text ?? '').includes('КЕДР'))

  console.log('\n[3] Спрашиваем агента, что он помнит — это и есть проверка')
  await clearInput()
  await page.keyboard.type(
    'Какие кодовые слова я просил тебя запомнить? Ответь только словами через запятую.'
  )
  await page.keyboard.press('Enter')
  await waitConv(id, (x) => x.streaming === true, 20_000)
  c = await waitConv(id, (x) => x.streaming === false)
  // Ответ — последний кусок ленты после нашего вопроса.
  const answer = (c?.text ?? '').split('через запятую.').pop() ?? ''
  ok('агент ответил', answer.trim().length > 0, answer.slice(0, 200))
  ok('КЕДР он помнит (беседа не потеряна)', /КЕДР/i.test(answer), answer.slice(0, 200))
  ok('ЛИПЫ в его памяти НЕТ (отменённое не вернулось)', !/ЛИПА|ЛИПУ|ЛИПЫ/i.test(answer), answer.slice(0, 300))
  ok('сессия ушла в новую ветку', c?.sessionId !== sessionBefore, c?.sessionId)
  ok('точка отмотки снята после init', !c?.resumeAt, c?.resumeAt)

  console.log(`\n[esc-rewind-live] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
