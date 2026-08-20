/**
 * У панели одно имя, и ответ агента можно унести с собой.
 *
 *   node scripts/feed-copy-test.mjs
 *
 * ДВЕ НАХОДКИ РАЗВЕДКИ, обе про одно — про то, что человек видит и чем он с
 * этим может распорядиться.
 *
 * 1. Один агент был подписан ДВУМЯ именами: в разделе «Агенты» — первыми
 *    словами его первого запроса, а в списке панелей выше — именем панели. Два
 *    списка одних и тех же агентов под несвязанными именами, в пяти
 *    сантиметрах друг от друга.
 *
 * 2. Из ленты нельзя было скопировать ответ. Пункт «Копировать» и Ctrl+Shift+C
 *    читали выделение xterm, а в блочном режиме лента закрывает терминал собой:
 *    человек выделял ответ мышью и получал неактивный пункт. Кнопка копирования
 *    была только у блока кода — прозу и вывод инструмента унести было нечем.
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
}
const note = (...a) => console.log('   ·', ...a)

const ud = mkdtempSync(join(tmpdir(), 'zarya-copy-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-copy-w-'))
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

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Панель с агентом и своим именем')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  await page.evaluate((s) => window.__zaryaRenameSession?.(s, 'сборка windows'), sid)
  await page.waitForTimeout(400)
  const conv = await page.evaluate(
    (s) =>
      window.__zaryaStartAgentIn?.(
        'codex',
        // «tool» — слово, по которому подставной движок просит разрешение:
        // без висящей карточки агент свободен, и в разделе «Агенты» его нет.
        'tool please: почини сборку на windows, там падает постпроцесс',
        s
      ),
    sid
  )
  await page.waitForTimeout(2500)
  ok('беседа поднялась', !!conv, { conv, sid })

  console.log('\n[2] В списке агентов панель названа СВОИМ именем')
  /*
   * Строку агента ищем по её ПОДПИСИ («выполняется» / «ждёт вас»), а не по
   * заголовку: заголовок — как раз то, что проверяется, и искать по нему
   * значило бы проверять догадку.
   *
   * И раздел «Агенты» показывает только занятых или ждущих: свободного там нет
   * вовсе. Поэтому агент выше остановлен на карточке разрешения — иначе строки
   * не было бы, а прогон винил бы переименование.
   */
  const crew = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-item')].map((el) => ({
      title: el.querySelector('.zy-item-title')?.textContent ?? '',
      hint: el.querySelector('.zy-item-title')?.getAttribute('title') ?? '',
      sub: el.querySelector('.zy-item-sub')?.textContent ?? ''
    }))
  )
  note('строки сайдбара:', JSON.stringify(crew.filter((x) => x.title)))
  const agentRow = crew.find((x) => /выполняется|ждёт вас/i.test(x.sub))
  ok('строка агента нашлась', !!agentRow, crew)
  ok('названа именем панели', agentRow?.title === 'сборка windows', agentRow)
  ok(
    'а первый запрос остался — но подсказкой',
    (agentRow?.hint ?? '').includes('почини сборку'),
    agentRow
  )

  console.log('\n[3] Выделенный в ленте ответ копируется')
  const answer = await page.evaluate(
    () => document.querySelector('.zy-mf-answer')?.textContent?.trim() ?? ''
  )
  note('ответ в ленте:', JSON.stringify(answer.slice(0, 60)))
  ok('ответ агента на экране есть', answer.length > 0, answer)

  // Выделяем ответ мышью — ровно так, как это делает человек.
  await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-answer')
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  })
  await page.waitForTimeout(200)
  await page.evaluate(() => window.__zaryaRunAction?.('terminal.copy'))
  await page.waitForTimeout(500)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  note('в буфере:', JSON.stringify(copied.slice(0, 60)))
  ok('в буфере оказался ответ, а не пустота', copied.trim().length > 0, copied.slice(0, 80))
  ok('и это именно он', answer.startsWith(copied.trim().slice(0, 20)), {
    copied: copied.slice(0, 60),
    answer: answer.slice(0, 60)
  })

  console.log('\n[4] И кнопка у самого ответа — без выделения вовсе')
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.evaluate(() => navigator.clipboard.writeText('—'))
  await page.waitForTimeout(200)
  const hasBtn = await page.evaluate(() => !!document.querySelector('.zy-mf-answer-copy'))
  ok('кнопка есть у ответа', hasBtn === true)
  await page.evaluate(() => document.querySelector('.zy-mf-answer-copy')?.click())
  await page.waitForTimeout(500)
  const copied2 = await page.evaluate(() => navigator.clipboard.readText())
  note('в буфере:', JSON.stringify(copied2.slice(0, 60)))
  ok('нажатие кладёт ответ в буфер', copied2.trim().length > 1 && copied2 !== '—', copied2.slice(0, 80))

  console.log('\n[5] Выделение в поле ввода остаётся делом браузера')
  /*
   * Подменять копирование в строке ввода нельзя: там работает встроенное
   * поведение поля, и перехват сломал бы привычное «выделил — скопировал».
   */
  const inField = await page.evaluate(() => {
    const input = document.querySelector('.zy-agentbar-input')
    if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) return null
    input.value = 'мой черновик'
    input.focus()
    input.setSelectionRange(0, 4)
    return window.__zaryaDomSelection?.() ?? ''
  })
  note('видит ли копирование поле ввода:', JSON.stringify(inField))
  ok('выделение в поле ввода не перехватывается', inField === '' || inField === null, inField)
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка останется — не повод падать */
    }
  }
}

console.log(`\n[feed-copy] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
