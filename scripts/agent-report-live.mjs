/**
 * Раскрытие вывода — на НАСТОЯЩЕМ Claude Code (нужна живая авторизация).
 *
 * Фейк (`agent-report-test.mjs`) доказывает нашу половину: если результат
 * многострочный, у строки появляется кнопка, а под ней весь текст. Чего фейк
 * доказать НЕ может — что настоящий движок отдаёт результат инструмента в том
 * же виде: одним куском, целиком, а не обрезанным до первой строки где-то
 * внутри SDK. Если бы обрезал, кнопка раскрывала бы ту же строку, что и так
 * видна, — и вся правка была бы украшением.
 *
 * Поэтому агента просят выполнить команду с ЗАВЕДОМО многострочным выводом и
 * смотрят, дошёл ли хвост до экрана.
 *
 * Стоит один короткий ход подписки. В обычный прогон не входит — руками:
 *   node scripts/agent-report-live.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-reportlive-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-reportlivew-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    // Без автопилота прогон встал бы на вопросе разрешения, а проверяется здесь
    // не гейт, а вывод. Каталог временный, ронять в нём нечего.
    ai: { autoApprove: true }
  })
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
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1100, 760)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.waitForTimeout(600)

  console.log('\n[1] Настоящий ход с многострочным выводом')
  const id = await page.evaluate(() =>
    window.__zaryaStartAgent?.(
      'claude-code',
      'Выполни ровно одну команду через Bash и ничего больше не делай: ' +
        'printf "СТРОКА-1\\nСТРОКА-2\\nСТРОКА-3\\nСТРОКА-4\\nХВОСТ-МЕТКА\\n". ' +
        'После этого ответь одним словом: готово.'
    )
  )
  // Живой агент неспешен: ждём состояния, а не «столько-то миллисекунд».
  const deadline = Date.now() + 120_000
  let conv = null
  while (Date.now() < deadline) {
    conv = await page.evaluate((i) => window.__zaryaConvById?.(i), id)
    if (conv && conv.streaming === false && (conv.text ?? '').length) break
    await page.waitForTimeout(700)
  }
  ok('агент отработал', conv?.streaming === false, conv?.text?.slice(0, 100))

  console.log('\n[2] Хвост вывода дошёл до экрана, а не остался в SDK')
  const head = await page.evaluate(
    () => document.querySelector('.zy-mf-outcome-head')?.textContent ?? null
  )
  ok('у результата появилась кнопка раскрытия', !!head, head)
  await page.click('.zy-mf-outcome-head')
  await page.waitForTimeout(500)
  const out = await page.evaluate(
    () => document.querySelector('.zy-mf-outcome-out')?.textContent ?? ''
  )
  // Главное утверждение прогона: видна ПОСЛЕДНЯЯ строка вывода. Первая видна и
  // без раскрытия — по ней ничего не докажешь.
  ok('последняя строка вывода на экране', /ХВОСТ-МЕТКА/.test(out), out.slice(0, 200))
  ok('и середина не потеряна', /СТРОКА-3/.test(out), out.slice(0, 200))
  if (shots) await page.screenshot({ path: join(shots, 'report-live.png') })

  console.log('\n[3] Ответ печатается на глазах — на настоящем движке')
  /*
   * Единственное, чего фейк доказать не может: что форма дельт у SDK и правда
   * та, которую мы разбираем (`content_block_delta` → `delta.text_delta`).
   * Ошибись мы в имени поля — печать просто не появилась бы, а прогон на фейке
   * остался бы зелёным.
   */
  const id2 = await page.evaluate(() =>
    window.__zaryaStartAgent?.(
      'claude-code',
      'Ответь ровно пятью предложениями о том, зачем нужен терминал. ' +
        'Без списков, без кода, без инструментов — просто текст.'
    )
  )
  // Ловим МОМЕНТ печати: опрашиваем часто и запоминаем самый первый непустой
  // кусок. «Подождать и посмотреть» здесь не годится — ответ придёт целиком.
  let firstSeen = ''
  let sawCaret = false
  const dl2 = Date.now() + 90_000
  while (Date.now() < dl2) {
    const snap = await page.evaluate(() => {
      const el = document.querySelector('.zy-mf-answer--typing')
      return el ? { text: el.textContent ?? '', caret: !!el.querySelector('.zy-mf-caret') } : null
    })
    if (snap && snap.text.trim()) {
      if (!firstSeen) firstSeen = snap.text
      sawCaret = sawCaret || snap.caret
      break
    }
    const c = await page.evaluate((i) => window.__zaryaConvById?.(i), id2)
    if (c && c.streaming === false) break
    await page.waitForTimeout(120)
  }
  ok('печать видна до конца ответа', !!firstSeen, firstSeen.slice(0, 80))
  ok('и с курсором', sawCaret, sawCaret)

  console.log('\n[4] Куски печати не осели в истории')
  const dl3 = Date.now() + 120_000
  let done2 = null
  while (Date.now() < dl3) {
    done2 = await page.evaluate((i) => window.__zaryaConvById?.(i), id2)
    if (done2 && done2.streaming === false && (done2.text ?? '').length) break
    await page.waitForTimeout(500)
  }
  const shape = await page.evaluate(() => ({
    typing: !!document.querySelector('.zy-mf-answer--typing'),
    answers: document.querySelectorAll('.zy-mf-answer').length
  }))
  ok('печать убралась', shape.typing === false, shape)
  // Ровно ОДИН ответ в этой беседе: кусок и целое сообщение — не два ответа, а
  // один и тот же. Два означали бы, что поток осел в истории отдельным ходом.
  ok('в ленте один ответ, а не два', shape.answers === 1, shape.answers)
  // И напечатанное — часть настоящего ответа, а не что-то своё. `text` моста
  // сшивает ВСЕ сообщения беседы, включая наш вопрос, поэтому ищем вхождение.
  ok(
    'напечатанное вошло в настоящий ответ',
    !!firstSeen && (done2?.text ?? '').includes(firstSeen.trim().slice(0, 24)),
    { typed: firstSeen.slice(0, 40), full: (done2?.text ?? '').slice(-60) }
  )
  if (shots) await page.screenshot({ path: join(shots, 'report-live-typing.png') })

  console.log(`\n[agent-report-live] PASS ${pass} · FAIL ${fail}`)
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
