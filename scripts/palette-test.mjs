/**
 * Палитра и сайдбар — то, чем пользуются, когда мыши не хватает.
 *
 * Три хвоста UX-аудита, закрытые вместе:
 *
 *  A4. `Ctrl+B` всегда открывал «Сессии». Человек, работавший с файлами, после
 *      сворачивания сайдбара оказывался не там, где был.
 *  A1. Ряд вкладок в шапке остался незаконченным: функции лежали, но не
 *      рисовались, и навигация по столам при скрытом сайдбаре была слепой —
 *      `Ctrl+Tab` перебирает по кругу, не показывая, куда ведёт. Мёртвый код
 *      убран, столы теперь ищутся в палитре по имени.
 *  F3. Всё, что появилось за последние выпуски (автопилот, ultracode,
 *      инструменты, подхват скиллов), жило только в баре: для того, кто ищет
 *      функцию по названию, её не существовало.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-palette-'))
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

  /** Заголовки действий палитры, отфильтрованные строкой поиска. */
  const palette = async (query) => {
    await page.evaluate(() => window.__zaryaSetUi?.({ paletteOpen: true }))
    await page.waitForTimeout(300)
    await page.fill('.zy-palette-input', query)
    await page.waitForTimeout(300)
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('.zy-palette-item-title, .zy-palette-item')].map((e) =>
        (e.textContent ?? '').trim()
      )
    )
    await page.evaluate(() => window.__zaryaSetUi?.({ paletteOpen: false }))
    await page.waitForTimeout(150)
    return items
  }

  console.log('\n[1] Ctrl+B возвращает тот раздел, что был открыт')
  const view = () => page.evaluate(() => window.__zaryaUi?.().sidebarView ?? null)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: 'history' }))
  await page.waitForTimeout(200)
  ok('открыли историю', (await view()) === 'history')
  await page.evaluate(() => window.__zaryaRunAction?.('app.toggle-sidebar'))
  await page.waitForTimeout(250)
  ok('свернули', (await view()) === null)
  await page.evaluate(() => window.__zaryaRunAction?.('app.toggle-sidebar'))
  await page.waitForTimeout(250)
  ok('развернули — и это снова история, а не «Сессии»', (await view()) === 'history', await view())

  console.log('\n[2] Действия агента есть в палитре')
  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(300)
  const agentItems = await palette('агент')
  const has = (needle) => agentItems.some((x) => x.toLowerCase().includes(needle))
  ok('автопилот', has('автопилот'), agentItems)
  ok('инструменты (MCP)', has('инструмент'), agentItems)
  ok('подхват скиллов и MCP', has('подхватить'), agentItems)

  console.log('\n[3] Чего движок не умеет — того в палитре нет')
  // У фейкового gemini нет ultracode: действие обязано исчезнуть, а не стоять
  // кнопкой, которая молча ничего не делает.
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'gemini'), sid)
  await page.waitForTimeout(300)
  const gemini = await palette('ultracode')
  ok('ultracode у движка без него не предлагается', !gemini.some((x) => /ultracode/i.test(x)), gemini)

  console.log('\n[4] Столы ищутся по имени, а не перебором')
  await page.evaluate(() => window.zarya)
  const tabs = await page.evaluate(async () => {
    await window.__zaryaNewTerminal?.()
    return window.__zaryaDumpSessions().tabs.length
  })
  await page.waitForTimeout(900)
  ok('столов стало больше одного', tabs >= 2, tabs)
  const desks = await palette('стол')
  ok('столы попали в палитру', desks.some((x) => x.startsWith('Стол:')), desks)
  // Текущий стол предлагать незачем: переходить в него неоткуда.
  const active = await page.evaluate(() => {
    const d = window.__zaryaDumpSessions()
    const tab = d.tabs.find((t) => t.id === d.activeTabId)
    return tab ? d.sessions[tab.activeSessionId]?.title ?? '' : ''
  })
  ok(
    'а тот, в котором стоим, — не предлагается',
    !desks.some((x) => active && x === `Стол: ${active}`),
    { active, desks }
  )

  console.log('\n[5] «Инструменты агента» ведут сразу в свой раздел')
  await page.evaluate(() => window.__zaryaRunAction?.('agent.tools'))
  await page.waitForTimeout(700)
  const openTab = await page.evaluate(
    () => document.querySelector('.zy-settings-nav-item--active')?.textContent ?? ''
  )
  ok('настройки открылись на «Инструментах»', /Инструменты/.test(openTab), openTab)

  console.log(`\n[palette] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}

if (fail) process.exit(1)
