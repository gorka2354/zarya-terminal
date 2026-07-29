/**
 * Esc над ОТПРАВЛЕННЫМ сообщением — как в настоящем CLI: оно исчезает из ленты
 * И из памяти агента, а текст возвращается в строку ввода.
 *
 * Почему «и из памяти» — главное. Транскрипты CLI это не журнал, а дерево
 * (`parentUuid`), и отмена там не удаляет запись, а продолжает от РОДИТЕЛЯ
 * отменённой: сообщение остаётся в файле мёртвой веткой и в контекст следующего
 * хода не попадает. Agent SDK даёт ровно это — `resumeSessionAt` + `forkSession`.
 * Поэтому проверять «пропало из ленты» недостаточно: спрятать с глаз то, что
 * агент помнит, — та самая неправда, из-за которой «я же отменил» и оказывалось
 * ложью. Тест смотрит, С ЧЕМ ушёл следующий ход (лог драйвера).
 *
 * Движки, которые так не умеют, обязаны вести себя по-старому — сообщение
 * остаётся с пометкой «прервано». Это проверяет esc-queue-test.mjs на codex;
 * здесь берётся gemini-фейк, у которого capability `rewind` включена.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-rewind-'))
const startLog = join(userData, 'starts.jsonl')
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
const starts = () =>
  existsSync(startLog)
    ? readFileSync(startLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_FAKE_START_LOG: startLog,
    NODE_ENV: 'production'
  }
})

const convById = (page, id) => page.evaluate((i) => window.__zaryaConvById?.(i), id)
const inputValue = (page) =>
  page.evaluate(() => document.querySelector('.zy-agentbar-input')?.value ?? null)
const feedText = (page) =>
  page.evaluate(() => document.querySelector('.zy-mf-scroll')?.textContent ?? '')
const clearInput = async (page) => {
  await page.click('.zy-agentbar-input')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'gemini' }))
  await page.waitForTimeout(400)

  console.log('\n[1] Первый ход: агент отвечает — появляется точка отмотки')
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'первый вопрос'))
  await page.waitForTimeout(1200)
  let conv = await convById(page, id)
  ok('ход завершён', conv?.streaming === false, conv?.streaming)
  ok('агент ответил', (conv?.text ?? '').includes('fake gemini'), conv?.text?.slice(0, 80))
  const sessionBefore = conv?.sessionId
  ok('сессия известна', !!sessionBefore, sessionBefore)

  console.log('\n[2] Второй ход, агент ещё молчит — Esc отменяет отправленное')
  await clearInput(page)
  await page.keyboard.type('mute: удали лишние логи')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  conv = await convById(page, id)
  ok('сообщение отправлено', (conv?.userTexts ?? []).some((t) => t.includes('удали лишние логи')))
  ok('агент работает', conv?.streaming === true, conv?.streaming)
  // conv.text — это вся лента вместе с репликой человека, поэтому смотрим на
  // фирменный префикс фейкового агента: ответа именно на этот ход быть не должно.
  ok('ответа на него ещё нет', !(conv?.text ?? '').includes('fake gemini: mute'), conv?.text?.slice(-80))

  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  conv = await convById(page, id)
  ok(
    'сообщения нет среди отправленных',
    !(conv?.userTexts ?? []).some((t) => t.includes('удали лишние логи')),
    conv?.userTexts
  )
  const shown = await feedText(page)
  ok('его нет и в ленте', !shown.includes('удали лишние логи'), shown.slice(-160))
  ok('пометки «прервано» не появилось', !shown.includes('прервано'), shown.slice(-160))
  ok('текст вернулся в строку ввода', (await inputValue(page)) === 'mute: удали лишние логи', await inputValue(page))
  ok('ход остановлен', conv?.streaming === false, conv?.streaming)
  ok('первый вопрос и ответ на месте', (conv?.userTexts ?? []).some((t) => t.includes('первый вопрос')))

  console.log('\n[3] Запомнена точка продолжения — ветка от ответа агента')
  ok('сессия для ветки та же', conv?.sessionId === sessionBefore, {
    was: sessionBefore,
    now: conv?.sessionId
  })
  ok('точка отмотки записана', typeof conv?.resumeAt === 'string' && conv.resumeAt.length > 0, conv?.resumeAt)
  const forkAt = conv?.resumeAt

  console.log('\n[4] Следующий ход уходит ВЕТКОЙ, отменённого в нём нет')
  await clearInput(page)
  await page.keyboard.type('а теперь просто скажи привет')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const log = starts()
  const lastStart = log[log.length - 1]
  ok('последний запуск — наш', lastStart?.prompt === 'а теперь просто скажи привет', lastStart)
  ok('он возобновляет прежнюю сессию', lastStart?.resume === sessionBefore, lastStart?.resume)
  ok('и обрезает историю по точке отмотки', lastStart?.resumeAt === forkAt, {
    got: lastStart?.resumeAt,
    want: forkAt
  })
  // Отменённое встречается в логе ровно один раз — тем самым ходом, который его
  // и отправил. Повтор означал бы, что оно вернулось агенту следующим запросом.
  ok(
    'отменённое не ушло агенту повторно',
    log.filter((s) => s.prompt.includes('удали лишние логи')).length === 1,
    log.map((s) => s.prompt)
  )

  conv = await convById(page, id)
  ok('после init точка отмотки снята', !conv?.resumeAt, conv?.resumeAt)
  ok('сессия сменилась на ветку', conv?.sessionId !== sessionBefore, conv?.sessionId)

  console.log('\n[5] Отмена первого же хода: продолжать не от чего — сессия с нуля')
  const id2 = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'mute: самый первый'))
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  const conv2 = await convById(page, id2)
  ok('сообщение убрано', (conv2?.userTexts ?? []).length === 0, conv2?.userTexts)
  ok('прежний id сессии забыт', !conv2?.sessionId, conv2?.sessionId)
  ok('точки отмотки нет', !conv2?.resumeAt, conv2?.resumeAt)

  console.log(`\n[esc-rewind] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
