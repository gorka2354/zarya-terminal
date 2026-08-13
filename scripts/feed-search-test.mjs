/**
 * Подсветка поиска по ленте: появляется и, главное, УХОДИТ.
 *
 *   node scripts/feed-search-test.mjs
 *
 * Владелец дважды прислал скриншот с «полосой, которая разделяет непонятно
 * что»: широкая полупрозрачная плашка поверх абзаца ответа. Это подсветка
 * найденного — она красит элемент целиком, потому что внутрь готового markdown
 * лезть нельзя (там же санитайзер). Пока ищешь, это помощь; если остаётся после
 * закрытия поиска — это уже полоса неизвестно чего посреди текста.
 *
 * Проверяется весь круг: нашли — подсветили — закрыли — сняли.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
  return !!cond
}
const note = (...a) => console.log('   ·', ...a)
const section = (s) => console.log(`\n${s}`)

const ud = mkdtempSync(join(tmpdir(), 'zarya-find-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-findw-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { themeId: 'zarya-plakat', language: 'ru' },
    sessions: { restoreOnLaunch: 'none' }
  })
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

/** Сколько сейчас подсвечено и есть ли «текущее» совпадение. */
const hits = (page) =>
  page.evaluate(() => ({
    all: document.querySelectorAll('.zy-mf-hit').length,
    now: document.querySelectorAll('.zy-mf-hit--now').length
  }))

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1280, 880)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2600)
  note('беседа:', cid)

  section('[1] Ищем слово из ответа — оно подсвечивается')
  // Поиск живёт при ПАНЕЛИ, а не при беседе: id разные, и подмена одного
  // другим даёт молчаливый ноль совпадений.
  // Панель берём из дампа сессий: свой геттер прогонам не открыт, а угадывать
  // id — верный способ проверить не то.
  const sid = await page.evaluate(() => {
    const d = window.__zaryaDumpSessions?.()
    return d?.activeSessionId ?? null
  })
  note('панель:', sid)
  await page.evaluate((s) => window.__zaryaSetUi?.({ searchOpenFor: s, feedQuery: 'fake' }), sid)
  await page.waitForTimeout(900)
  const found = await hits(page)
  note('подсвечено:', JSON.stringify(found))
  ok('совпадения подсвечены', found.all > 0, found)
  ok('текущее — ровно одно', found.now === 1, found)

  section('[2] Меняем запрос на несуществующий — подсветка снимается')
  await page.evaluate(() => window.__zaryaSetUi?.({ feedQuery: 'щыщыщы' }))
  await page.waitForTimeout(800)
  const none = await hits(page)
  ok('ничего не подсвечено', none.all === 0 && none.now === 0, none)

  section('[3] Закрываем поиск — подсветка не остаётся полосой посреди текста')
  await page.evaluate(() => window.__zaryaSetUi?.({ feedQuery: 'fake' }))
  await page.waitForTimeout(700)
  ok('перед закрытием подсветка есть', (await hits(page)).all > 0)
  await page.evaluate(() => window.__zaryaSetUi?.({ searchOpenFor: null }))
  await page.waitForTimeout(900)
  const after = await hits(page)
  note('после закрытия:', JSON.stringify(after))
  // Ровно та жалоба: «полоса, разделяющая непонятно что» — это подсветка,
  // пережившая поиск. Пока поиск открыт, она объясняется строкой поиска на
  // экране; после закрытия объяснять её нечем.
  ok('подсветка снята', after.all === 0 && after.now === 0, after)

  section('[4] Лента продолжает жить — новая реплика не воскрешает подсветку')
  await page.evaluate(() => window.__zaryaFollowUp?.('ещё раз'))
  await page.waitForTimeout(2600)
  const later = await hits(page)
  ok('после нового хода подсветки нет', later.all === 0, later)
} finally {
  await app.close()
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка */
    }
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
