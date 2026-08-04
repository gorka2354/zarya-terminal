/**
 * Английский интерфейс — без единой русской буквы.
 *
 * Перевести пятьсот строк можно только одним честным способом: обойти экраны и
 * посмотреть, что осталось. Глазами это делается один раз и с ошибками, поэтому
 * обходит прогон: включает английский, открывает всё, что открывается, и
 * собирает кириллицу из РАЗМЕТКИ — включая подписи (title), заголовки и
 * плейсхолдеры.
 *
 * Он же — список работы: пока перевод не закончен, прогон печатает, где именно
 * осталось русское.
 *
 * Данные не в счёт: путь к папке, вывод оболочки и ответ агента могут быть на
 * любом языке — это не интерфейс.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-i18n-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra, null, 1) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
})

/** Собрать кириллицу из разметки — с адресом, чтобы было что чинить. */
const CYR_SCAN = () => {
  const CYR = /[а-яА-ЯёЁ]/
  // Данные, а не интерфейс: терминал, путь в шапке панели, ответ агента, вывод.
  // Данные, а не интерфейс: вывод оболочки, ответ агента, пути и заголовки
  // ПРОШЛЫХ бесед — они приходят из истории пользователя и написаны на том
  // языке, на котором он работал.
  const DATA = [
    '.zy-term',
    '.zy-mf-out',
    '.zy-mf-answer',
    '.zy-mf-cmd',
    '.zy-mf-msg-user',
    '.zy-resume',
    '.zy-pane-header-cwd',
    // Выбор языка: каждый язык подписан на себе самом — «Русский» в английском
    // списке не ошибка, а единственный способ найти свой язык, не зная чужого.
    '[data-lang-select]'
  ]
  const found = []
  const where = (el) => {
    const parts = []
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      parts.unshift(n.className ? `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]}` : n.tagName.toLowerCase())
    }
    return parts.join(' > ')
  }
  const isData = (el) => DATA.some((sel) => el.closest?.(sel))
  // 1. Видимый текст.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue || '').trim()
    if (!text || !CYR.test(text)) continue
    const el = n.parentElement
    if (!el || isData(el)) continue
    found.push({ kind: 'text', text: text.slice(0, 60), at: where(el) })
  }
  // 2. Подписи и плейсхолдеры — их не видно, пока не наведёшь, но человек их читает.
  for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    if (isData(el)) continue
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(attr)
      if (v && CYR.test(v)) found.push({ kind: attr, text: v.slice(0, 60), at: where(el) })
    }
  }
  return found
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3200)

  console.log('\n[1] Язык переключается без перезапуска')
  await page.evaluate(() => window.__zaryaSetLang('en'))
  await page.waitForTimeout(800)
  ok('английский включился', (await page.evaluate(() => window.__zaryaLang())) === 'en')

  console.log('\n[2] Главный экран — без кириллицы')
  const main = await page.evaluate(CYR_SCAN)
  ok('шапка, сайдбар, лента и строка ввода переведены', main.length === 0, main.slice(0, 12))

  console.log('\n[3] Меню и панели — без кириллицы')
  await page.evaluate(() => window.__zaryaSplitActive('row'))
  await page.waitForTimeout(1400)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves[0])
  await page.click(`.zy-pane-row[data-session="${sid}"]`, { button: 'right' })
  await page.waitForTimeout(500)
  const paneMenu = await page.evaluate(CYR_SCAN)
  ok('меню панели переведено', paneMenu.length === 0, paneMenu.slice(0, 10))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  await page.click('.zy-titlebar-proj')
  await page.waitForTimeout(500)
  const projMenu = await page.evaluate(CYR_SCAN)
  ok('меню проектов переведено', projMenu.length === 0, projMenu.slice(0, 10))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  console.log('\n[4] Настройки и пульт — без кириллицы')
  await page.evaluate(() => window.__zaryaSetUi({ settingsOpen: true }))
  await page.waitForTimeout(900)
  const settings = await page.evaluate(CYR_SCAN)
  ok('центр управления переведён', settings.length === 0, settings.slice(0, 12))
  await page.evaluate(() => window.__zaryaSetUi({ settingsOpen: false, launchPadOpen: true }))
  await page.waitForTimeout(800)
  const pad = await page.evaluate(CYR_SCAN)
  ok('пусковой комплекс переведён', pad.length === 0, pad.slice(0, 10))
  await page.evaluate(() => window.__zaryaSetUi({ launchPadOpen: false }))

  console.log('\n[5] Русский остался нетронутым')
  await page.evaluate(() => window.__zaryaSetLang('ru'))
  await page.waitForTimeout(800)
  const ru = await page.evaluate(() => {
    const el = document.querySelector('.zy-sidebar-header')
    const bar = document.querySelector('.zy-agentbar-input')
    return { header: el?.textContent ?? '', placeholder: bar?.getAttribute('placeholder') ?? '' }
  })
  ok('сайдбар снова по-русски', /Сессии/.test(ru.header), ru)
  ok('строка ввода тоже', /[а-яА-Я]/.test(ru.placeholder), ru)

  console.log('\n[6] Словари полны')
  const missing = await page.evaluate(() => window.__zaryaMissingKeys?.() ?? { inEn: [], inRu: [] })
  ok('в английском нет пропусков', missing.inEn.length === 0, missing.inEn.slice(0, 20))
  ok('в русском нет пропусков', missing.inRu.length === 0, missing.inRu.slice(0, 20))

  console.log(`\n[i18n] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
