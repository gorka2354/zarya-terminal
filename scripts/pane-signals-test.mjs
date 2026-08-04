/**
 * Признаки панели: рамка, состояние агента и швы сетки.
 *
 * Три вещи, которые легко сломать незаметно, потому что все они — оформление:
 *
 *  1. РАМКА и СОСТОЯНИЕ — разные признаки. Рамка отвечает на «куда уйдёт Enter»,
 *     состояние — на «что происходит». Раньше ждущая панель обводилась
 *     пульсирующим кантом того же цвета, и два признака читались как один:
 *     «активная панель». Признак, который нельзя отличить, сигналом не является.
 *  2. «ЖДЁТ» и «РАБОТАЕТ» — тоже разные, и по цвету: accent зовёт человека,
 *     success говорит «занят, ничего не нужно».
 *  3. ШОВ между панелями виден. На светлой теме его не было вовсе: четыре
 *     панели сливались в одно белое поле.
 *
 * Проверяется вычисленный стиль, а не наличие класса: класс можно оставить, а
 * правило потерять — и на экране не будет ничего.
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-signals-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-sigwork-'))
// Светлая тема намеренно: именно на ней пропадали швы, и именно её проверяем.
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru', themeId: 'zarya-golden-hour' },
    sessions: { restoreOnLaunch: 'none' }
  })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Размер задаёт САМО окно: setViewportSize растягивает вьюпорт поверх окна и
  // добавляет в кадр чёрные поля, которых человек не видит.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1362, 861)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1400)
  await page.evaluate((d) => window.__zaryaSplitActive?.('right', d), work)
  await page.waitForTimeout(1600)

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-pane')]
      .filter((p) => p.getBoundingClientRect().top > 10 && p.getBoundingClientRect().width > 100)
      .map((p) => p.getAttribute('data-session'))
  )
  ok('две панели на экране', ids.length >= 2, ids.length)

  console.log('\n[1] Шов между панелями виден на светлой теме')
  const seam = await page.evaluate(() => {
    const g = document.querySelector('.zy-gutter')
    if (!g) return null
    const cs = getComputedStyle(g, '::before')
    return { bg: cs.backgroundColor, w: cs.width, content: cs.content }
  })
  ok('шов нарисован', !!seam && seam.content !== 'none', seam)
  ok('он в один пиксель', seam?.w === '1px', seam?.w)
  ok(
    'и он не прозрачный — иначе панели сливаются',
    !!seam && !/rgba\(0, 0, 0, 0\)|transparent/.test(seam.bg),
    seam?.bg
  )

  // Заставку смотрим ДО запуска агентов: она живёт только в пустой панели, а
  // дальше по прогону обе панели заняты работой.
  console.log('\n[2] Заставка стоит посередине, а не липнет к шапке')
  const hero = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.zy-mf-empty')].find(
      (x) => x.getBoundingClientRect().width > 100
    )
    if (!e) return null
    const cs = getComputedStyle(e)
    const mark = e.querySelector('.zy-mf-empty-mark')?.getBoundingClientRect()
    const head = e.closest('.zy-mf')?.querySelector('.zy-mf-head')?.getBoundingClientRect()
    return {
      justify: cs.justifyContent,
      gap: mark && head ? Math.round(mark.top - head.bottom) : null,
      titleFont: getComputedStyle(e.querySelector('.zy-mf-empty-title') ?? e).fontFamily
    }
  })
  ok('заставка на экране есть', !!hero, hero)
  ok('содержимое центрируется', /center/.test(hero?.justify ?? ''), hero?.justify)
  // `safe` — не украшение: обычный center при нехватке высоты выносит ВЕРХ
  // содержимого за границу, и знак уезжает под шапку.
  ok('и центрируется безопасно — верх не уедет под шапку', /safe/.test(hero?.justify ?? ''), hero?.justify)
  ok('знак не касается шапки', (hero?.gap ?? 0) > 4, hero?.gap)
  // Pixelify Sans рисует кириллический мягкий знак высотой с заглавную:
  // «начинатЬ». Заголовок берёт Handjet, где он строчный.
  ok('заголовок не на шрифте с заглавным «ь»', !/Pixelify/.test(hero?.titleFont ?? ''), hero?.titleFont)

  console.log('\n[3] «Ждёт» и «работает» — полосой сверху, а не рамкой')
  // Гейт: фейковый агент останавливается и ждёт решения человека.
  await page.evaluate((sid) => window.__zaryaFocusPane?.(sid), ids[0])
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__zaryaAskAgent?.('запусти tool', 'codex'))
  await page.waitForTimeout(1600)
  // «mute» — ход, в котором агент долго молчит: панель работает, не спрашивая.
  await page.evaluate((sid) => window.__zaryaFocusPane?.(sid), ids[1])
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__zaryaAskAgent?.('mute подумай подольше', 'codex'))
  await page.waitForTimeout(1800)

  const marks = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-pane')]
      .filter((p) => p.getBoundingClientRect().top > 10)
      .map((p) => {
        const bar = getComputedStyle(p, '::before')
        const ring = getComputedStyle(p, '::after')
        return {
          waiting: p.classList.contains('zy-pane--waiting'),
          working: p.classList.contains('zy-pane--working'),
          focused: p.classList.contains('zy-pane--focused'),
          barH: bar.height,
          barTop: bar.top,
          barImg: bar.backgroundImage.slice(0, 30),
          barColor: bar.backgroundColor,
          barAnim: bar.animationName,
          ringShadow: ring.boxShadow.slice(0, 40)
        }
      })
  )
  const waiting = marks.find((m) => m.waiting)
  const working = marks.find((m) => m.working)
  ok('панель, которая ждёт решения, нашлась', !!waiting, marks)
  ok('панель, которая работает, нашлась', !!working, marks)
  ok('у ждущей есть полоса сверху', waiting?.barH === '4px' && waiting?.barTop === '0px', waiting)
  ok('у работающей тоже', working?.barH === '4px' && working?.barTop === '0px', working)
  // Разные цвета — главное различие: одна зовёт, вторая просто занята.
  ok(
    'ждущая красится акцентом, а не градиентом',
    waiting?.barImg === 'none' && !!waiting?.barColor && waiting.barColor !== 'rgba(0, 0, 0, 0)',
    waiting
  )
  ok(
    'работающая — бегущим бликом, а не ровным акцентом',
    (working?.barImg ?? '').startsWith('linear-gradient'),
    working?.barImg
  )
  ok('и она движется', working?.barAnim === 'zy-work-run', working?.barAnim)
  ok('ждущая пульсирует', waiting?.barAnim === 'zy-wait-pulse', waiting?.barAnim)

  console.log('\n[4] Рамка осталась только у активной — она про Enter, не про состояние')
  // Считаем только ВИДИМЫЕ панели: у скрытой вкладки своя активная, и она
  // законно помечена — на экране её нет, врать она не может.
  const framed = await page.evaluate(
    () =>
      [...document.querySelectorAll('.zy-pane--focused')].filter(
        (p) => p.getBoundingClientRect().width > 100
      ).length
  )
  ok('на экране активная панель ровно одна', framed === 1, framed)
  const waitingBorder = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.zy-pane--waiting')][0]
    return p ? getComputedStyle(p).borderTopColor : null
  })
  // Ждущая панель, если она не активна, рамку НЕ красит: иначе снова два
  // одинаковых признака.
  const waitingIsFocused = await page.evaluate(
    () => !![...document.querySelectorAll('.zy-pane--waiting')][0]?.classList.contains('zy-pane--focused')
  )
  ok(
    'ждущая не притворяется активной рамкой',
    waitingIsFocused || /rgba\(0, 0, 0, 0\)|transparent/.test(waitingBorder ?? ''),
    { waitingBorder, waitingIsFocused }
  )

  console.log('\n[5] Палитра «/» не меняет высоту при переходе по списку')
  /*
   * Потолок стоял только на списке команд, а описание справа росло свободно.
   * Палитра прижата к строке ввода и потому вырастала ВВЕРХ: у команды с
   * десятистрочным описанием (у Claude Code это, например, `/doctor`) вся
   * панель подпрыгивала на полсотни пикселей — и уезжала из-под курсора ровно
   * в момент, когда человек в неё целился.
   *
   * Замеряется положение и высота на первой строке и на строке с длинным
   * описанием. Без общего потолка эти числа расходятся — проверено подрывом:
   * верх уезжал с 293 на 205, высота росла с 288 до 376.
   */
  // Колонка описания живёт только в широкой панели (в сетке 2×2 её прячет
  // контейнерный запрос), а без неё проверять нечего — оставляем одну панель.
  await page.evaluate((sid) => window.__zaryaCloseSession?.(sid), ids[1])
  await page.waitForTimeout(1200)
  await page.evaluate((sid) => window.__zaryaFocusPane?.(sid), ids[0])
  await page.waitForTimeout(400)
  await page.evaluate(() => document.querySelector('.zy-agentbar-input')?.focus())
  await page.waitForTimeout(300)
  await page.keyboard.type('/')
  await page.waitForTimeout(1200)
  const palette = async () =>
    await page.evaluate(() => {
      const el = document.querySelector('.zy-cmdlist')
      const prev = document.querySelector('.zy-cmdlist-preview')
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        top: Math.round(b.top),
        h: Math.round(b.height),
        hasPreview: !!prev,
        prevScrolls: prev ? prev.scrollHeight > prev.clientHeight : false,
        cur: document.querySelector('.zy-cmdlist-item--on')?.textContent?.slice(0, 12) ?? ''
      }
    })
  const p1 = await palette()
  ok('палитра открылась со списком', !!p1 && !!p1.cur, p1)
  // Список циклический: два шага вверх от начала — команда фейка с самым
  // длинным описанием.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(500)
  const p2 = await palette()
  ok('дошли до команды с длинным описанием', /fake-long/.test(p2?.cur ?? ''), p2)
  ok('колонка описания на экране есть', p2?.hasPreview === true, p2)
  ok(
    'описание действительно длиннее области — иначе проверка ничего не значит',
    p2?.prevScrolls === true,
    p2
  )
  ok('верх палитры не сдвинулся', p1?.top === p2?.top, { p1: p1?.top, p2: p2?.top })
  ok('и высота осталась прежней', p1?.h === p2?.h, { p1: p1?.h, p2: p2?.h })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  console.log('\n[6] Полоса «ОТВЕТ АГЕНТА» — только там, где есть что отделять')
  /*
   * Она граница между командами терминала и беседой, а не заголовок беседы.
   * Рисовалась всегда: в панели, где команд нет, получалась линия во всю
   * ширину, которая ничего не отделяет, — а в пустой беседе просто пустая
   * полоса под шапкой. Именно её и видно на скриншотах как «тонкую полосу».
   */
  const noBlocks = await page.evaluate(() => {
    const pane = [...document.querySelectorAll('.zy-pane')].find(
      (p) => p.querySelector('.zy-mf-user') && p.getBoundingClientRect().width > 100
    )
    return pane
      ? {
          hasDivider: !!pane.querySelector('.zy-mf-divider'),
          shell: pane.querySelectorAll('.zy-mf-block').length
        }
      : null
  })
  ok('в панели с беседой команд терминала нет', noBlocks?.shell === 0, noBlocks)
  ok('и полосы тоже нет — отделять нечего', noBlocks?.hasDivider === false, noBlocks)

  // А теперь СМЕШАННАЯ лента: команды выше беседы. Здесь полоса — настоящая
  // граница, и убрать её значило бы потерять смысл, а не шум.
  const sid = await page.evaluate(() => {
    const pane = [...document.querySelectorAll('.zy-pane')].find((p) => p.querySelector('.zy-mf-user'))
    return pane?.getAttribute('data-session')
  })
  await page.evaluate((x) => window.__zaryaSeedBlocks?.(x, 2, 3), sid)
  await page.waitForTimeout(1200)
  const mixed = await page.evaluate(() => {
    const pane = [...document.querySelectorAll('.zy-pane')].find((p) => p.querySelector('.zy-mf-user'))
    const d = pane?.querySelector('.zy-mf-divider')
    return {
      hasDivider: !!d,
      text: (d?.textContent ?? '').trim(),
      shell: pane?.querySelectorAll('.zy-mf-block').length ?? 0
    }
  })
  ok('команды терминала появились', mixed.shell > 0, mixed)
  ok('полоса вернулась — ей есть что разделять', mixed.hasDivider === true, mixed)
  ok('и она подписана', /ОТВЕТ АГЕНТА/.test(mixed.text), mixed.text)

  console.log('\n[7] Кнопка «панель» выглядит кнопкой')
  const pult = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.zy-agentbar-fuel-pult')][0]
    if (!b) return null
    const cs = getComputedStyle(b)
    return { border: cs.borderTopWidth, color: cs.borderTopColor, w: Math.round(b.getBoundingClientRect().width) }
  })
  ok('у неё есть рамка', pult?.border === '1px', pult)
  ok(
    'и рамка видимая, а не прозрачная',
    !!pult && !/rgba\(0, 0, 0, 0\)/.test(pult.color),
    pult?.color
  )

  console.log(`\n[pane-signals] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
