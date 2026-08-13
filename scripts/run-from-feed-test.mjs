/**
 * Команда, запущенная из ленты, обязана быть ВИДНА в ленте.
 *
 *   node scripts/run-from-feed-test.mjs
 *
 * Владелец нажал «запустить» у блока кода из ответа агента, подтвердил диалог —
 * и не увидел ничего: ни строки команды, ни вывода, ни ошибки. Панель сменила
 * папку, то есть команда выполнилась, но лента об этом промолчала. Запуск
 * вслепую хуже отсутствия кнопки: человек не знает, случилось ли что-нибудь.
 *
 * Проверяется то, что видит человек: одна строка и — отдельно — две строки
 * разом, как в блоке «cd … / cargo run».
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-run-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-runw-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { themeId: 'zarya-plakat', language: 'ru' },
    sessions: { restoreOnLaunch: 'none' }
  })
)

/*
 * По умолчанию — сборка из исходников. `ZARYA_EXE=<путь>` гоняет тот же прогон
 * против УПАКОВАННОЙ: пути к встроенным ресурсам там другие, и проверять их
 * надо там, где ими пользуется человек.
 */
const exe = process.env.ZARYA_EXE || ''
const app = await electron.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: exe ? [] : [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

/** Что показывает лента: команды блоков и их состояние. */
const blocks = (page) =>
  page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    return [...document.querySelectorAll('.zy-mf-block')].filter(vis).map((b) => ({
      cmd: (b.querySelector('.zy-mf-cmd')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      out: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(-60)
    }))
  })

/** Отправить в оболочку ровно тем же путём, что и кнопка «запустить». */
const run = (page, sid, code) =>
  page.evaluate(([s, c]) => window.zarya.pty.write(s, c + '\r'), [sid, code])

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1280, 880)
    w.center()
  })
  await page.waitForTimeout(3000)
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  note('панель:', sid)

  section('[0] Сверка: штатный путь — команда из строки ввода Зари')
  /*
   * Опора для сравнения. Если и здесь блока нет, дело не в кнопке «запустить», а
   * в разметке оболочки — и чинить надо совсем другое.
   */
  const дал = await page.evaluate((s) => window.__zaryaRunShell?.('echo штатный-путь', s), sid)
  note('__zaryaRunShell вернул:', JSON.stringify(дал))
  await page.waitForTimeout(9000)
  const штат = await blocks(page)
  // Что вообще есть в ленте: если блоков нет, но есть другие элементы, значит
  // ищем не тот класс; если пусто совсем — не поднялась разметка оболочки.
  const срез = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const feed = [...document.querySelectorAll('.zy-mf-scroll')].filter(vis)[0]
    return {
      детей: feed?.children.length ?? 0,
      классы: [...(feed?.querySelectorAll('*') ?? [])]
        .map((e) => String(e.className || ''))
        .filter((c) => c.startsWith('zy-mf'))
        .slice(0, 12),
      текст: (feed?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    }
  })
  note('в ленте:', JSON.stringify(срез))
  // Что видит СТОР блоков: если и там пусто, разметка оболочки не доехала —
  // значит дело не в ленте, а в самом терминале.
  const стор = await page.evaluate((s) => window.__zaryaDumpBlocks?.(s), sid)
  note('в сторе блоков:', JSON.stringify(стор).slice(0, 300))
  // Жив ли сам терминал: читаем его буфер. Если и он пуст — оболочка не
  // запустилась, и разговор про блоки преждевременный.
  const экран = await page.evaluate((s) => {
    const term = window.__zaryaTermText?.(s)
    return typeof term === 'string' ? term.replace(/\s+/g, ' ').trim().slice(-200) : '(нет хука)'
  }, sid)
  note('экран терминала:', JSON.stringify(экран))
  // Спрашиваем саму оболочку: подхватила ли она наш скрипт разметки.
  await run(page, sid, 'if ($Global:__ZaryaIntegrated) { "ИНТЕГРАЦИЯ-ЕСТЬ" } else { "ИНТЕГРАЦИИ-НЕТ" }')
  await page.waitForTimeout(3500)
  const ответ = await page.evaluate((s) => {
    const t = window.__zaryaTermText?.(s)
    return typeof t === 'string' ? t.replace(/\s+/g, ' ').slice(-260) : ''
  }, sid)
  note('оболочка ответила:', JSON.stringify(ответ))
  note('после штатного запуска блоков:', штат.length, JSON.stringify(штат.slice(-1)))
  ok('штатный путь блок даёт', штат.length > 0, штат)

  section('[1] Одна строка — блок появляется, вывод виден')
  await run(page, sid, 'echo одна-строка-ок')
  await page.waitForTimeout(4000)
  const один = await blocks(page)
  note('блоков:', один.length, JSON.stringify(один.slice(-2)))
  ok('блок появился', один.length > 0, один)
  ok('в нём наша команда', один.some((b) => /одна-строка-ок/.test(b.cmd)), один)
  ok('и её вывод', один.some((b) => /одна-строка-ок/.test(b.out)), один)

  section('[2] ДВЕ строки разом — как в блоке «cd … / cargo run»')
  const было = (await blocks(page)).length
  await run(page, sid, 'echo первая-строка\necho вторая-строка')
  await page.waitForTimeout(5000)
  const два = await blocks(page)
  note('блоков стало:', два.length, JSON.stringify(два.slice(-3)))
  // Две команды — два блока: иначе человек видит одну и думает, что вторая не
  // выполнялась (а она выполнилась).
  ok('блоков прибавилось', два.length > было, { было, стало: два.length })
  ok('первая строка видна', два.some((b) => /первая-строка/.test(b.cmd + b.out)), два.slice(-3))
  ok('вторая строка тоже', два.some((b) => /вторая-строка/.test(b.cmd + b.out)), два.slice(-3))

  section('[3] После запуска можно ПЕЧАТАТЬ — фокус вернулся в строку ввода')
  /*
   * Второй отчёт владельца, из того же нажатия: «не мог писать, пока не
   * переключился на другой проект и обратно; строка ввода не подсвечивалась и
   * не мигала». Фокус уходил в скрытое поле xterm — оно есть в DOM, но его нет
   * на экране, и печатать становилось некуда.
   */
  await run(page, sid, 'echo проверка-фокуса')
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid)
  await page.waitForTimeout(1500)
  const фокус = await page.evaluate(() => {
    const el = document.activeElement
    return {
      тег: el?.tagName ?? '(нет)',
      класс: String(el?.className || '').slice(0, 40),
      вСкрытом: !!el?.closest?.('.zy-term-wrap')
    }
  })
  note('фокус:', JSON.stringify(фокус))
  ok('курсор не в скрытом терминале', фокус.вСкрытом === false, фокус)
  ok('а в поле, где можно печатать', /TEXTAREA|INPUT/.test(фокус.тег), фокус)

  section('[4] Команда, которой нет, — ошибка обязана быть видна')
  await run(page, sid, 'этой-команды-нет-совсем')
  await page.waitForTimeout(4500)
  const плохо = await blocks(page)
  note('последний блок:', JSON.stringify(плохо.slice(-1)))
  ok(
    'провал показан, а не проглочен',
    плохо.some((b) => /этой-команды-нет/.test(b.cmd + b.out)),
    плохо.slice(-2)
  )
  section('[5] Команда, запущенная ПОСЛЕ разговора, видна рядом с разговором')
  /*
   * Ровно случай владельца: длинная беседа с агентом, потом «запустить» у блока
   * кода — и «ничего не произошло». На самом деле блок появлялся, но в САМОМ
   * ВЕРХУ ленты: команды оболочки рисовались выше всей беседы, а человек стоял
   * внизу, за километр от них.
   */
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2600)
  await run(page, sid, 'echo команда-после-разговора')
  await page.waitForTimeout(4500)
  const порядок = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const feed = [...document.querySelectorAll('.zy-mf-scroll')].filter(vis)[0]
    const узлы = [...(feed?.querySelectorAll('.zy-mf-block, .zy-mf-userturn') ?? [])]
    const блок = узлы.findIndex((n) => /команда-после-разговора/.test(n.textContent ?? ''))
    const разговор = узлы.findIndex((n) => n.classList.contains('zy-mf-userturn'))
    return { блок, разговор, всего: узлы.length }
  })
  note('порядок в ленте:', JSON.stringify(порядок))
  ok('блок команды нашёлся', порядок.блок >= 0, порядок)
  // Хронология: то, что случилось позже, стоит ниже. Иначе «ничего не
  // произошло» — честный вывод человека, который смотрит в конец ленты.
  ok('он НИЖЕ разговора, а не над ним', порядок.блок > порядок.разговор, порядок)
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
