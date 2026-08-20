/**
 * Мёртвых нажатий нет: ничто не уводит в слой, которого у человека нет.
 *
 *   node scripts/dead-clicks-test.mjs
 *
 * ПОВОД. Разведка 2026-08-19 нашла в конфигурации ПО УМОЛЧАНИЮ четыре элемента,
 * которые нажимаются и не делают ничего: строка «ждёт вас» в сайдбаре вела в
 * панель ИИ, которой при выключенном IDE не существует; Ctrl+P находил файл и
 * не открывал его (редактор — часть той же надстройки); ссылка из ошибки
 * посылала во вкладку настроек, которую список прячет; переключатель «Плотность
 * интерфейса» не имел во всём `src` ни одного потребителя.
 *
 * Чинить их поодиночке — значит ждать, пока разведка найдёт пятый. Этот прогон
 * сторожит ПРАВИЛО: при настройках по умолчанию ни одно действие не должно
 * оставить человека в невидимом слое — открытый файл без редактора, «открытую»
 * панель ИИ, которой не рисуют, настройки на вкладке, которой нет в списке.
 *
 * ПЕРВАЯ ВЕРСИЯ ЭТОГО ПРОГОНА МЕРИЛА «ИЗМЕНИЛСЯ ЛИ DOM» — и объявила мёртвыми
 * двадцать пять живых действий: смену стола, шрифт, очистку экрана,
 * копирование. Эффект у них есть, просто его не видно в наборе классов. Врал
 * прибор, а не код; правило пришлось сформулировать точнее.
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-dead-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-dead-w-'))
// НАСТРОЙКИ ПО УМОЛЧАНИЮ — в этом весь смысл: именно так приложение стоит у
// человека, который его не крутил. Пишем только язык, чтобы читать подписи.
writeFileSync(join(ud, 'settings.json'), JSON.stringify({ appearance: { language: 'ru' } }))

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

/** Состояние тех самых мест, где ловится этот класс дефектов. */
const layerState = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('.zy-settings-nav-item--active')?.textContent ?? ''
    return {
      ide: window.__zaryaSettings?.().ideMode === true,
      aiPanelOpen: (window.__zaryaDumpUi?.() ?? {}).aiPanelOpen === true,
      editorFiles: document.querySelectorAll('.zy-editor-tab').length,
      settingsOpen: !!document.querySelector('.zy-settings'),
      // Вкладки надстройки подписаны своим разделом («IDE · AGENT») — по нему
      // и узнаём, не завела ли нас ошибка туда, где вкладки не существует.
      ideTab: /IDE/i.test(nav),
      nav
    }
  })

/** Закрыть всё, что могло открыться, чтобы следующее действие мерилось начисто. */
const reset = async (page) => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false, launchPadOpen: false }))
  await page.waitForTimeout(120)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)

  console.log('\n[1] Настройки — те, с которыми человек видит приложение впервые')
  const defaults = await page.evaluate(() => ({
    ide: window.__zaryaSettings?.().ideMode,
    density: 'uiDensity' in (window.__zaryaSettings?.().appearance ?? {})
  }))
  note('умолчания:', JSON.stringify(defaults))
  ok('надстройка IDE выключена', defaults.ide === false, defaults)
  ok('мёртвой настройки «плотность» больше нет', defaults.density === false, defaults)

  console.log('\n[2] Ничто не уводит в слой, которого нет')
  /*
   * Действия, которые НЕЛЬЗЯ звать в прогоне: они уводят из приложения или
   * ломают его сам. Список короткий и назван поимённо — молчаливое исключение
   * здесь было бы дырой того же вида, что мы чиним.
   */
  const SKIP = new Set([
    'app.quit',
    'app.reload',
    'app.devtools',
    'tab.close',
    'terminal.close-pane',
    'app.check-updates'
  ])
  const ids = await page.evaluate(() => (window.__zaryaActions?.() ?? []).map((a) => a.id))
  note('доступных действий:', ids.length)
  ok('реестр не пуст', ids.length > 20, ids.length)

  const stranded = []
  const broke = []
  for (const id of ids) {
    if (SKIP.has(id)) continue
    await reset(page)
    // Слой возвращаем в исходное перед каждым действием: одно из них его
    // включает намеренно (быстрое открытие файла), и без сброса все следующие
    // проверялись бы уже во включённом слое — то есть ни в чём.
    await page.evaluate(() => window.__zaryaSetIde?.(false))
    await page.waitForTimeout(120)
    await page.evaluate((x) => window.__zaryaRunAction?.(x), id)
    await page.waitForTimeout(300)
    const st = await layerState(page)
    const bad =
      (st.editorFiles > 0 && !st.ide) ||
      (st.aiPanelOpen && !st.ide) ||
      (st.settingsOpen && st.ideTab && !st.ide)
    if (bad) stranded.push({ id, ...st })
    /*
     * И ЖИВО ЛИ ВООБЩЕ ОКНО ПОСЛЕ ЭТОГО ДЕЙСТВИЯ.
     *
     * ErrorBoundary в Заре нет (разведка это назвала): ошибка в отрисовке
     * уносит всё дерево, и на экране остаётся пустота. Прогон, который этого не
     * замечает, дальше меряет несуществующий интерфейс и винит невиновных.
     */
    const alive = await page.evaluate(() => document.querySelectorAll('.zy-pane').length)
    if (!alive) {
      broke.push(id)
      break
    }
  }
  await reset(page)
  await page.evaluate(() => window.__zaryaSetIde?.(false))
  note('проверено действий:', ids.length - SKIP.size)
  ok('ни одно не оставляет человека в невидимом слое', stranded.length === 0, stranded)
  ok('и ни одно не роняет окно', broke.length === 0, broke)

  console.log('\n[3] Быстрое открытие: файл не только находится, но и открывается')
  /*
   * Через реестр, а не клавишей: клавиатурный путь проверяет соседний прогон,
   * а здесь важно поведение самого действия. Ctrl+P в панели уходит в xterm, и
   * прогон мерил бы маршрутизацию клавиш, а не тупик.
   */
  await page.evaluate(() => window.__zaryaRunAction?.('app.quick-open'))
  await page.waitForTimeout(700)
  const opened = await page.evaluate(() => ({
    overlay: !!document.querySelector('.zy-overlay-backdrop'),
    ide: window.__zaryaSettings?.().ideMode,
    ui: (window.__zaryaDumpUi?.() ?? {}).quickOpenOpen
  }))
  note('после вызова:', JSON.stringify(opened))
  ok('оверлей открылся', opened.overlay === true, opened)
  ok('и слой, в котором живёт редактор, включён', opened.ide === true, opened)
  await reset(page)
  await page.evaluate(() => window.__zaryaSetIde?.(false))

  console.log('\n[4] К ждущему агенту есть путь — и он ведёт в его панель')
  /*
   * Агент — в ОДНОЙ панели, курсор — в ДРУГОЙ. Иначе «перешли» и «мы и так тут
   * стояли» неотличимы, и проверка зеленеет сама собой: ровно так первая
   * версия этой секции и делала.
   */
  /*
   * ДЕЛИМ панель, а не открываем новый стол: `__zaryaNewTerminal` заводит стол,
   * и панели оказались бы на разных экранах — прогон мерил бы переход между
   * столами вместо перехода между соседями. Сценарий находки — четыре панели
   * рядом.
   */
  await page.evaluate(() => window.__zaryaRunAction?.('terminal.split-right'))
  await page.waitForTimeout(2500)
  const panes = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-pane')].map((el) => el.getAttribute('data-session'))
  )
  // Панелей к этому моменту больше двух: цикл выше звал и деление, и новый
  // стол. Считать их бессмысленно — важно, что соседей минимум двое.
  ok('на столе есть соседи', panes.length >= 2, panes)
  const paneA = panes[0]
  const paneB = panes.find((x) => x !== paneA)
  const conv = await page.evaluate(
    (a) => window.__zaryaStartAgentIn?.('codex', 'tool please', a),
    paneA
  )
  await page.waitForTimeout(2200)
  const gate = await page.evaluate(
    (c) => (window.__zaryaConvById?.(c)?.pendingTools ?? []).some((t) => !t.settled),
    conv
  )
  ok('карточка появилась — есть кого ждать', gate === true, { conv, gate, paneA, paneB })

  await page.evaluate((s) => window.__zaryaFocusPane?.(s), paneB)
  await page.waitForTimeout(500)
  const before = await page.evaluate(
    () => document.querySelector('.zy-pane--focused')?.getAttribute('data-session') ?? ''
  )
  ok('курсор стоит в ДРУГОЙ панели', before === paneB, { before, paneA, paneB })

  const acts = await page.evaluate(() => (window.__zaryaActions?.() ?? []).map((a) => a.id))
  ok('действие «перейти к ждущему» есть в реестре', acts.includes('agent.focus-waiting'), acts)
  await page.evaluate(() => window.__zaryaRunAction?.('agent.focus-waiting'))
  await page.waitForTimeout(700)
  const active = await page.evaluate(
    () => document.querySelector('.zy-pane--focused')?.getAttribute('data-session') ?? ''
  )
  note('панель до:', JSON.stringify(before), '· после:', JSON.stringify(active), '· ждёт:', JSON.stringify(paneA))
  ok('переход привёл в панель того, кто ждёт', active === paneA && active !== before, {
    before,
    active,
    paneA
  })

  console.log('\n[5] Развернуть, вынести и переименовать — есть чем, кроме мыши')
  for (const id of ['terminal.maximize-pane', 'terminal.rename-pane']) {
    ok(`${id} есть в реестре`, acts.includes(id), acts.filter((x) => x.startsWith('terminal.')))
  }
  /*
   * «Вынести» — единственное из трёх с условием: на столе с ОДНОЙ панелью
   * выносить нечего, и действие обязано честно отсутствовать. Соседей сейчас
   * несколько, значит оно должно быть.
   */
  const actsNow = await page.evaluate(() => (window.__zaryaActions?.() ?? []).map((a) => a.id))
  ok(
    'вынести — доступно, когда на столе есть соседи',
    actsNow.includes('terminal.detach-pane'),
    actsNow.filter((x) => x.startsWith('terminal.'))
  )
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

console.log(`\n[dead-clicks] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
