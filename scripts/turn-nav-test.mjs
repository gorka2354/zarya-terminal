/**
 * Прыжки по своим сообщениям — и откат прямо оттуда.
 *
 *   node scripts/turn-nav-test.mjs
 *
 * Мысль владельца: в длинной сессии ищешь не ответ агента, а собственную
 * реплику — «что я вообще просил». Листать километр ленты ради этого нельзя, а
 * кнопка отката живёт как раз в строке хода. Значит навигация по своим ходам
 * решает две задачи разом, и проверять надо обе: попали в нужный ход И можем
 * оттуда откатиться, не разыскивая кнопку наведением.
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
const shots = process.env.ZARYA_SHOTS || ''

const ud = mkdtempSync(join(tmpdir(), 'zarya-nav-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-navw-'))
const cfg = mkdtempSync(join(tmpdir(), 'zarya-navc-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { themeId: 'zarya-plakat', language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    ai: { fileCheckpoints: true }
  })
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    // Изолированный прогон копий не заслуживает — кроме случая, когда увёл
    // настройки движка в свою папку. Здесь точки отката нужны по существу.
    CLAUDE_CONFIG_DIR: cfg,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const nav = (page) =>
  page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const box = [...document.querySelectorAll('.zy-mf-turnnav')].filter(vis)[0]
    return box
      ? {
          есть: true,
          счётчик: box.querySelector('.zy-mf-turnnav-count')?.textContent ?? '',
          кнопок: box.querySelectorAll('.zy-mf-turnnav-btn').length
        }
      : { есть: false }
  })

/** Какой ход сейчас подсвечен и видно ли у него кнопку отката. */
const found = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.zy-mf-userturn--found')
    if (!el) return null
    const btn = [...el.querySelectorAll('.zy-mf-changes-btn')].find((b) =>
      /Откатить/.test(b.textContent ?? '')
    )
    return {
      текст: (el.querySelector('.zy-mf-user-text')?.textContent ?? '').trim().slice(0, 40),
      кнопкаОтката: !!btn,
      видимость: btn ? getComputedStyle(btn).opacity : ''
    }
  })

const жать = (page, вниз = false) =>
  page.evaluate((d) => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const box = [...document.querySelectorAll('.zy-mf-turnnav')].filter(vis)[0]
    const btns = box?.querySelectorAll('.zy-mf-turnnav-btn')
    ;(d ? btns?.[1] : btns?.[0])?.click()
  }, вниз)

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

  section('[1] Один ход — навигатора нет')
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'первая просьба'))
  await page.waitForTimeout(2200)
  const один = await nav(page)
  note(JSON.stringify(один))
  // Навигация по одному пункту — это не навигация, а лишний значок на экране.
  ok('при одном ходе кнопок нет', один.есть === false, один)

  section('[2] Ходов стало больше — навигатор появился и считает их')
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), cid)
  for (const text of ['вторая просьба', 'третья просьба', 'четвёртая просьба']) {
    await page.evaluate((p) => window.__zaryaFollowUp?.(p), text)
    await page.waitForTimeout(1800)
  }
  const много = await nav(page)
  note(JSON.stringify(много))
  ok('навигатор на экране', много.есть === true, много)
  ok('кнопок две', много.кнопок === 2, много)
  ok('счётчик знает про четыре хода', /\/4$/.test(много.счётчик), много.счётчик)
  if (shots) await page.screenshot({ path: join(shots, 'turnnav-1.png') })

  section('[3] Прыжок вверх ведёт к предыдущей своей реплике')
  await жать(page)
  await page.waitForTimeout(900)
  const первый = await found(page)
  note('подсвечен:', JSON.stringify(первый), '| счётчик:', (await nav(page)).счётчик)
  ok('ход подсвечен', !!первый, первый)
  ok('это моя реплика, а не ответ агента', /просьба/.test(первый?.текст ?? ''), первый)
  // Ради этого всё и затевалось: попал в место — откатывайся отсюда же.
  ok('кнопка отката видна сразу', первый?.кнопкаОтката === true, первый)
  ok('и она не приглушена', первый?.видимость === '1', первый)

  section('[4] Ещё прыжок — уходим выше, к более раннему ходу')
  const былоТекст = первый?.текст
  await жать(page)
  await page.waitForTimeout(900)
  const второй = await found(page)
  note('подсвечен:', JSON.stringify(второй), '| счётчик:', (await nav(page)).счётчик)
  ok('перешли к другому ходу', второй && второй.текст !== былоТекст, { былоТекст, второй })

  section('[5] Стрелка вниз возвращает обратно')
  await жать(page, true)
  await page.waitForTimeout(900)
  const назад = await found(page)
  note('подсвечен:', JSON.stringify(назад), '| счётчик:', (await nav(page)).счётчик)
  ok('вернулись ниже', назад && назад.текст === былоТекст, { ждали: былоТекст, назад })
  if (shots) await page.screenshot({ path: join(shots, 'turnnav-2.png') })

  section('[6] Клавиши Alt+↑ / Alt+↓ делают то же самое')
  /*
   * Клавишу отправляем событием, а не через Playwright.
   *
   * `keyboard.press('Alt+ArrowUp')` в offscreen-Electron доносит стрелку без
   * модификатора: проверено — тем же нажатием ничего не происходит, а ручное
   * событие с altKey срабатывает. Это ограничение стенда, а не продукта:
   * проверяем ОБРАБОТЧИК, путь от клавиатуры ОС проверяется руками.
   */
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })
    )
  )
  await page.waitForTimeout(900)
  const клавишей = await found(page)
  note('после Alt+↑:', JSON.stringify(клавишей), '| счётчик:', (await nav(page)).счётчик)
  ok('клавиша сработала', !!клавишей, клавишей)
} finally {
  await app.close()
  for (const d of [ud, work, cfg]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка */
    }
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
