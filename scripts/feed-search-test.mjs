/**
 * Поиск ищет по тому, что человек видит.
 *
 * Лупа в шапке панели открывала строку поиска, которая работала через xterm —
 * а в блочном режиме xterm рендерится ЗА ЭКРАНОМ. Человек вводил слово, которое
 * видел перед собой, и не происходило ничего: кнопка была на месте, поиска не
 * было. Пункт C6 UX-аудита.
 *
 * Теперь в блочном режиме строка ищет по ленте: командам с их выводом, ответам
 * агента и карточкам инструментов. В сыром режиме — по терминалу, как раньше.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-find-'))
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
  await page.waitForTimeout(2500)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)

  console.log('\n[1] В ленте есть что искать')
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  // Все три хода — в ОДНУ беседу: лента панели показывает активную, и три
  // отдельные беседы дали бы на экране только последнюю.
  const conv = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'запомни альфа'))
  await page.waitForTimeout(900)
  for (const word of ['бета', 'альфа']) {
    await page.evaluate(([c, w]) => window.__zaryaSendIn?.(c, `запомни ${w}`), [conv, word])
    await page.waitForTimeout(1100)
  }
  // Ждём именно ответов, а не «на глазок»: иначе прогон падал бы от медленной
  // машины, а не от ошибки. Смотрим в стор — он источник, из которого лента
  // рисуется, и не зависит от того, какая панель сейчас на экране.
  let said = ''
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300)
    said = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.zy-mf-scroll')]
      return boxes.map((e) => e.textContent ?? '').join(' ')
    })
    if (said.includes('альфа') && said.includes('бета')) break
  }
  ok('лента наполнилась', said.includes('альфа') && said.includes('бета'), said.slice(-120))

  console.log('\n[2] Строка поиска ищет по ленте, а не по невидимому терминалу')
  await page.evaluate((s) => window.__zaryaSetUi?.({ searchOpenFor: s }), sid)
  await page.waitForTimeout(400)
  ok('строка поиска открылась', !!(await page.$('.zy-searchbar input')))
  await page.fill('.zy-searchbar input', 'альфа')
  await page.waitForTimeout(600)

  const hits = await page.evaluate(() => ({
    marked: document.querySelectorAll('.zy-mf-hit').length,
    now: document.querySelectorAll('.zy-mf-hit--now').length,
    counter: (document.querySelector('.zy-searchbar-count')?.textContent ?? '').trim(),
    state: window.__zaryaUi?.().feedHits
  }))
  ok('совпадения подсвечены', hits.marked >= 2, hits)
  ok('текущее — ровно одно', hits.now === 1, hits)
  ok('счётчик говорит, сколько нашлось', /\d+\s*из\s*\d+/.test(hits.counter), hits.counter)
  if (shots) await page.screenshot({ path: join(shots, 'feed-search.png') })

  console.log('\n[3] «Дальше» ведёт к следующему и замыкается в кольцо')
  const at = () =>
    page.evaluate(() => window.__zaryaUi?.().feedHits ?? { count: 0, index: 0 })
  const first = await at()
  await page.click('.zy-searchbar .zy-icon-btn:nth-of-type(1)')
  await page.waitForTimeout(400)
  const second = await at()
  ok('перешли к следующему', second.index !== first.index, { first, second })
  // Дойдя до конца, «дальше» обязано вернуть к первому: молча переставший
  // работать переход читается как поломка.
  for (let i = 0; i < first.count + 1; i++) {
    await page.click('.zy-searchbar .zy-icon-btn:nth-of-type(1)')
    await page.waitForTimeout(150)
  }
  const looped = await at()
  ok('счётчик не вышел за пределы', looped.index < looped.count, looped)

  console.log('\n[4] Не найдено — так и сказано')
  await page.fill('.zy-searchbar input', 'этого-точно-нет')
  await page.waitForTimeout(500)
  const none = await page.evaluate(() => ({
    marked: document.querySelectorAll('.zy-mf-hit').length,
    counter: (document.querySelector('.zy-searchbar-count')?.textContent ?? '').trim()
  }))
  ok('подсветки нет', none.marked === 0, none)
  ok('и это названо словами, а не пустотой', /не найдено/i.test(none.counter), none.counter)

  console.log('\n[5] Esc закрывает и убирает подсветку')
  await page.fill('.zy-searchbar input', 'альфа')
  await page.waitForTimeout(400)
  await page.press('.zy-searchbar input', 'Escape')
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => ({
    bar: !!document.querySelector('.zy-searchbar'),
    marked: document.querySelectorAll('.zy-mf-hit').length,
    query: window.__zaryaUi?.().feedQuery
  }))
  ok('строка закрылась', after.bar === false, after)
  ok('подсветка снята', after.marked === 0, after)
  ok('запрос забыт — следующий поиск начнётся с чистого', !after.query, after.query)

  console.log('\n[6] В сыром режиме поиск остаётся терминальным')
  await page.evaluate((s) => window.__zaryaSetRawFor?.(s, true), sid)
  await page.waitForTimeout(400)
  await page.evaluate((s) => window.__zaryaSetUi?.({ searchOpenFor: s }), sid)
  await page.waitForTimeout(400)
  const raw = await page.evaluate(() => ({
    placeholder: document.querySelector('.zy-searchbar input')?.getAttribute('placeholder') ?? '',
    counter: !!document.querySelector('.zy-searchbar-count')
  }))
  ok('подпись про терминал, а не про ленту', /терминал/i.test(raw.placeholder), raw.placeholder)
  ok('счётчика ленты здесь нет', raw.counter === false, raw)

  console.log(`\n[feed-search] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}

if (fail) process.exit(1)
