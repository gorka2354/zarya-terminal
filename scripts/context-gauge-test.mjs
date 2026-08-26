/**
 * Постоянный показатель заполнения контекста (inc-44).
 *
 *   node scripts/context-gauge-test.mjs
 *
 * Повод — наблюдение владельца: у родного CLI такого показателя нет из коробки
 * (там `/usage` руками либо своя статусная строка), и это неудобно. У Зари он
 * когда-то был и его убрали вместе с перегруженной полосой лимитов.
 *
 * Главный вопрос прогона не «рисуется ли», а НЕ ВРЁТ ЛИ. Число заполнения
 * приходило в общее состояние окна, и его перезаписывал любой движок в любой
 * панели: постоянный показатель над одним разговором приносил бы числа из
 * соседнего. Это и проверяется двумя панелями.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '') }
}
const note = (...a) => console.log('   ·', ...a)

const ud = mkdtempSync(join(tmpdir(), 'zarya-ctxg-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const conv = (page, id) => page.evaluate((x) => window.__zaryaConvById?.(x), id)
/**
 * Показатель в НИЖНЕЙ ПОЛОСЕ — там он теперь и живёт, рядом с лимитами
 * подписки. В ряду чипов над строкой ввода он отнимал место у самой строки:
 * при сетке 2×2 органы управления упирались в поле ввода.
 */
const gauge = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.zy-strip-ctx')
    if (!el) return null
    return {
      text: el.textContent?.trim() ?? '',
      title: el.getAttribute('title') ?? '',
      width: el.querySelector('.zy-strip-ctx-fill')?.style?.width ?? null,
      full: el.className.includes('--full')
    }
  })
/**
 * Предупреждение в САМОЙ панели. Ниже порога его нет вовсе; с 80% заполнение
 * перестаёт быть показателем и становится предупреждением — прочитать о нём
 * надо там, куда человек смотрит, и именно про ЭТУ панель, а не про активную.
 */
const paneWarn = (page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll('.zy-agentbar-ctx')]
    return els.map((el) => el.textContent?.trim() ?? '')
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Показатель виден БЕЗ единого нажатия — в нижней полосе')
  ok('до первого хода показывать нечего', (await gauge(page)) === null)
  // Панель, в которой идёт первый разговор: полоса показывает АКТИВНУЮ, и
  // ниже проверяется, что она идёт за фокусом туда и обратно.
  const sid1 = await page.evaluate(() => window.__zaryaDumpSessions?.()?.activeSessionId)
  const a = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2500)
  const g1 = await gauge(page)
  note('показатель:', JSON.stringify(g1))
  ok('после хода показатель на месте', !!g1, g1)
  ok('и называет число, а не только рисует полосу', /\d+%/.test(g1?.text ?? ''), g1?.text)
  ok('полоса заполнена на то же число', g1?.width === '37%', g1?.width)
  /*
   * Ряд чипов панели — органы управления: каждый отвечает на вопрос «что
   * случится с этим ходом». Показателю среди них не место, пока он не стал
   * предупреждением (проверка [4]).
   */
  ok('в самой панели чипа нет — ряд чипов разгружен', (await paneWarn(page)).length === 0)

  console.log('\n[2] Числа — движка, а не наши')
  /*
   * Заря принципиально не считает токены сама. Подсказка обязана называть то,
   * что прислал движок: 74K из 200K — ровно то, что отдал подставной драйвер.
   */
  note('подсказка:', JSON.stringify(g1?.title))
  ok('в подсказке токены от движка', /74K/.test(g1?.title ?? '') && /200K/.test(g1?.title ?? ''), g1?.title)
  const c1 = await conv(page, a)
  ok('и они же лежат в беседе', c1?.context?.tokens === 74000 && c1?.context?.window === 200000, c1?.context)

  console.log('\n[3] ГЛАВНОЕ: показатель принадлежит СВОЕЙ панели')
  /*
   * Прежде число жило в общем состоянии окна, и его перезаписывал любой движок.
   * Поднимаем вторую панель со своим разговором и подменяем ей заполнение —
   * показатель первой не должен шелохнуться.
   */
  const sid2 = await page.evaluate(() => window.__zaryaNewTerminal?.())
  await page.waitForTimeout(2500)
  const b = await page.evaluate((s) => window.__zaryaStartAgentIn?.('codex', 'и я', s), sid2)
  await page.waitForTimeout(2500)
  const c2 = await conv(page, b)
  ok('у второй панели свой контекст', c2?.context?.pct === 37, c2?.context)
  ok('и у первой он не пропал', (await conv(page, a))?.context?.pct === 37, c1?.context)

  console.log('\n[3a] Панель БЕЗ своего хода не показывает чужое число')
  /*
   * Запасной вариант «нет своего — покажем общее по окну» я сперва написал и
   * выбросил: общее значение перезаписывает любая панель, и свежая показывала
   * бы соседское число как своё. Пустое место честнее чужой цифры.
   */
  const sid3 = await page.evaluate(() => window.__zaryaNewTerminal?.())
  await page.waitForTimeout(2000)
  // Фокус переводим ЯВНО: создание панели его не переносит, и без этого строка
  // продолжает показывать прежнюю панель — её число там законно.
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid3)
  await page.waitForTimeout(1200)
  const active = await page.evaluate(() => window.__zaryaDumpSessions?.()?.activeSessionId)
  ok('фокус действительно на свежей панели', active === sid3, { active, sid3 })
  /*
   * ГЛАВНАЯ ОПАСНОСТЬ ПЕРЕЕЗДА. Полоса одна на окно, а разговоров в нём столько
   * же, сколько панелей: она обязана показывать ЧИСЛО АКТИВНОЙ панели и пустеть
   * на свежей. Показать здесь соседское число — ровно то враньё, ради которого
   * контекст в прошлом выпуске переехал в беседу.
   */
  const panes = await page.evaluate(() => document.querySelectorAll('.zy-agentbar').length)
  const strips = await page.evaluate(() => document.querySelectorAll('.zy-strip').length)
  note('панелей на экране:', panes, '· полос:', strips)
  ok('полоса одна на окно, панелей больше', strips === 1 && panes >= 3, { strips, panes })
  ok('на свежей панели полоса пуста — чужого не показывает', (await gauge(page)) === null)

  console.log('\n[3b] Полоса идёт за фокусом, а не запоминает первое увиденное')
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid2)
  await page.waitForTimeout(1200)
  const back = await gauge(page)
  note('вернулись во вторую панель:', JSON.stringify(back))
  ok('число вернулось вместе с фокусом', /37%/.test(back?.text ?? ''), back?.text)
  // Возвращаемся в первую: дальше проверяется её порог.
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid1)
  await page.waitForTimeout(1200)

  console.log('\n[4] Порог «почти полно» помечен, но не только цветом')
  await page.evaluate(
    (id) => window.__zaryaSeedContext?.(id, { pct: 88, tokens: 176000, window: 200000 }),
    a
  )
  await page.waitForTimeout(600)
  const g2 = await gauge(page)
  note('на 88%:', JSON.stringify(g2))
  ok('число обновилось', /88%/.test(g2?.text ?? ''), g2?.text)
  ok('и отмечено как заполненное', g2?.full === true, g2)
  /*
   * Признак обязан читаться БЕЗ цвета: ревью справедливо поймало первую версию,
   * где порог держался на одном оттенке — ровно то, что мы чинили инкрементом
   * раньше. Сравниваем разметку двух состояний, стили не смотрим.
   */
  ok('у порога есть знак, а не только оттенок', /!/.test(g2?.text ?? ''), g2?.text)
  /*
   * И ГЛАВНОЕ ПРО ПОРОГ: предупреждение возвращается в САМУ панель.
   *
   * Общая полоса говорит об активной панели, а «скоро сжатие» — это про ту, где
   * идёт разговор. С 80% чип встаёт обратно в ряд чипов: там, куда человек
   * смотрит, и ровно у той панели, которой это грозит.
   */
  const warn2 = await paneWarn(page)
  note('чипы-предупреждения в панелях:', JSON.stringify(warn2))
  ok('на пороге предупреждение вернулось в панель', warn2.length === 1, warn2)
  ok('и оно со знаком, а не одним оттенком', /!/.test(warn2[0] ?? ''), warn2[0])
  ok('и называет число', /88%/.test(warn2[0] ?? ''), warn2[0])
  await page.evaluate((id) => window.__zaryaSeedContext?.(id, { pct: 40, tokens: 80000, window: 200000 }), a)
  await page.waitForTimeout(500)
  const g3 = await gauge(page)
  ok('ниже порога знака нет — разметка РАЗНАЯ', !/!/.test(g3?.text ?? ''), g3?.text)
  ok('и панель снова разгружена', (await paneWarn(page)).length === 0)

  console.log('\n[5] «Агент забыл разговор» — число уходит вместе с памятью')
  /*
   * Ход `/clear` токенов не тратит: движок присылает нулевую usage, свежего
   * числа не приходит вовсе. Без сброса чип показывал бы прежние проценты
   * рядом с чертой «дальше агент не помнит» — два соседних утверждения, из
   * которых одно ложь.
   */
  const before = await conv(page, a)
  note('до сброса контекст:', JSON.stringify(before?.context))
  // Событие «движок забыл разговор» доставляем тем же путём, каким его
  // приносит драйвер, — иначе проверялась бы не та дорога.
  await page.evaluate((id) => window.__zaryaAgentEvent?.(id, { type: 'reset', sessionId: 'new-sid' }), a)
  await page.waitForTimeout(600)
  const afterReset = await conv(page, a)
  note('после сброса:', JSON.stringify(afterReset?.context))
  ok('заполнение сброшено вместе с памятью агента', !afterReset?.context, afterReset?.context)
  if (process.env.ZARYA_SHOT) await page.screenshot({ path: process.env.ZARYA_SHOT })
} catch (e) {
  fail++
  console.log('  ✗ ПРОГОН УПАЛ:', e?.message || e)
} finally {
  await app.close().catch(() => {})
  rmSync(ud, { recursive: true, force: true })
}

console.log(`\nИтог: ${pass} прошло, ${fail} упало`)
process.exit(fail ? 1 : 0)
