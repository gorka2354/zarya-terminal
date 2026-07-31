/**
 * Работа в НЕСКОЛЬКИХ панелях — то, ради чего затевался inc-17.
 *
 * Всё остальное в проекте проверяется с одной панелью, а обещания этого
 * инкремента живут ровно там, где панелей несколько: один Enter не должен
 * одобрять несколько команд, текст обязан уходить в свою оболочку, автопилот и
 * режимы принадлежат панели, микрофон один на всех. Без этого прогона всё
 * перечисленное — рассуждения, а не факты.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-panes-'))
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

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
})

/**
 * Жалобы окна. Панели рисуются списком с ключами, раскладка живёт в стилях —
 * ошибки и предупреждения React здесь не украшение, а признак того, что список
 * пересобирается не так, как задумано.
 */
const complaints = []

try {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') complaints.push(m.text().slice(0, 200))
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3200)

  console.log('\n[1] Четыре панели, у каждой своя лента и своя строка')
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(700)
  }
  await page.waitForTimeout(800)
  const counts = await page.evaluate(() => ({
    panes: document.querySelectorAll('.zy-pane').length,
    feeds: document.querySelectorAll('.zy-mf').length,
    inputs: document.querySelectorAll('.zy-agentbar-input').length,
    strips: document.querySelectorAll('.zy-strip').length,
    fuelInPanes: document.querySelectorAll('.zy-pane .zy-agentbar-fuel').length
  }))
  ok('четыре панели', counts.panes === 4, counts)
  ok('четыре ленты', counts.feeds === 4, counts)
  ok('четыре строки ввода', counts.inputs === 4, counts)
  ok('одна общая полоса внизу', counts.strips === 1, counts)
  ok('топливомера в панелях нет', counts.fuelInPanes === 0, counts)

  const ids = await page.evaluate(() => window.__zaryaDumpSessions().sessions.map((s) => s.id))
  ok('сессий тоже четыре', ids.length === 4, ids.length)

  console.log('\n[2] Текст уходит в СВОЮ оболочку, а не в чужую')
  // Печатаем в строку ТРЕТЬЕЙ панели и смотрим, куда попала команда.
  const inputs = await page.$$('.zy-agentbar-input')
  await inputs[2].click()
  await page.keyboard.type('echo ПАНЕЛЬ-ТРИ')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1800)
  const texts = await page.evaluate((list) => list.map((id) => window.__zaryaTermText(id)), ids)
  ok('команда выполнилась в третьей панели', /ПАНЕЛЬ-ТРИ/.test(texts[2] ?? ''), (texts[2] ?? '').slice(-90))
  ok(
    'в остальных панелях её нет',
    [0, 1, 3].every((i) => !/ПАНЕЛЬ-ТРИ/.test(texts[i] ?? '')),
    texts.map((t) => (t ?? '').slice(-40))
  )

  console.log('\n[3] Один Enter одобряет РОВНО ОДНУ команду — в панели с фокусом')
  // Гейт поднимаем в двух панелях сразу: у фейкового движка это делает слово «tool».
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'gemini' }))
  await page.waitForTimeout(300)
  const convs = await page.evaluate(async (sids) => {
    const out = []
    for (const sid of [sids[0], sids[1]]) {
      window.__zaryaFocusPane?.(sid)
      out.push(window.__zaryaStartAgentIn?.('gemini', 'tool: поработай', sid))
      await new Promise((r) => setTimeout(r, 900))
    }
    return out
  }, ids)
  await page.waitForTimeout(1500)
  const gatesBefore = await page.evaluate(
    (cs) => cs.map((c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length),
    convs
  )
  ok('гейт висит в обеих панелях', gatesBefore.every((n) => n > 0), gatesBefore)

  // Фокус во ВТОРУЮ панель и один Enter.
  // Фокусируем как человек: щелчком по строке ввода нужной панели.
  const inputs2 = await page.$$('.zy-agentbar-input')
  await inputs2[1].click()
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const gatesAfter = await page.evaluate(
    (cs) => cs.map((c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length),
    convs
  )
  ok('гейт сфокусированной панели решён', gatesAfter[1] === 0, gatesAfter)
  ok('гейт СОСЕДНЕЙ панели не тронут', gatesAfter[0] > 0, gatesAfter)

  console.log('\n[4] Автопилот принадлежит своей панели')
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), convs[0])
  await page.waitForTimeout(400)
  const bypass = await page.evaluate(
    (cs) => cs.map((c) => window.__zaryaConvById(c)?.bypass === true),
    convs
  )
  ok('включён только в своей беседе', bypass[0] === true && bypass[1] === false, bypass)

  console.log('\n[5] Режим одной панели не гасит соседние')
  await page.evaluate((sid) => window.__zaryaSetRawFor(sid, true), ids[0])
  await page.waitForTimeout(600)
  const raw = await page.evaluate(() => window.__zaryaRawMap())
  const feedsNow = await page.evaluate(() => document.querySelectorAll('.zy-mf').length)
  ok('сырой режим только у первой', raw[ids[0]] === true && !raw[ids[1]], raw)
  ok('ленты соседних панелей на месте', feedsNow === 3, feedsNow)

  console.log('\n[6] Картинка попадает в ТУ панель, где курсор')
  const paste = await page.evaluate(async () => {
    const c = new OffscreenCanvas(1200, 800)
    const x = c.getContext('2d')
    x.fillStyle = '#e2231a'
    x.fillRect(0, 0, 1200, 800)
    const blob = await c.convertToBlob({ type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
    const inputs = document.querySelectorAll('.zy-agentbar-input')
    inputs[2].focus()
    inputs[2].dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    )
    await new Promise((r) => setTimeout(r, 1600))
    return {
      panes: document.querySelectorAll('.zy-pane').length,
      chips: document.querySelectorAll('.zy-img-chip').length
    }
  })
  // Порядок строк в разметке не совпадает с порядком сессий в сторе, поэтому
  // проверяем не номер, а суть: вложение у той панели, где стоял курсор.
  const focused = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  const perPane = await page.evaluate(
    (list) => list.map((id) => (window.__zaryaPendingImages(id) ?? []).length),
    ids
  )
  ok('вложение появилось ровно одно', paste.chips === 1, paste)
  const onFocused = await page.evaluate((sid) => (window.__zaryaPendingImages(sid) ?? []).length, focused)
  ok('вложение у панели с курсором', onFocused === 1, { focused, perPane })
  ok('и больше ни у кого', perPane.filter((n) => n > 0).length === 1, perPane)
  // Без stopPropagation дроп всплыл бы в общий обработчик окна и открыл терминал.
  ok('лишних панелей не появилось', paste.panes === 4, paste)
  const meta = await page.evaluate((sid) => window.__zaryaPendingImages(sid), focused)
  ok('картинка уменьшена до предела', meta[0]?.width <= 1568 && meta[0]?.height <= 1568, meta)

  console.log('\n[7] Не-картинка добавляется ПУТЁМ, а не содержимым')
  const drop = await page.evaluate(async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['текст файла'], 'notes.txt', { type: 'text/plain' }))
    const inputsAll = [...document.querySelectorAll('.zy-agentbar-input')]
    // Берём ПОСЛЕДНЮЮ доступную строку: сколько их видно, зависит от режимов
    // панелей, а проверяем мы не номер панели, а сам жест.
    const last = inputsAll[inputsAll.length - 1]
    const target = last.closest('.zy-agentbar-row') ?? last
    target.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    )
    await new Promise((r) => setTimeout(r, 900))
    return {
      panes: document.querySelectorAll('.zy-pane').length,
      value: last.value,
      chips: document.querySelectorAll('.zy-img-chip').length
    }
  })
  // Содержимое файла в контекст не инлайним: агент прочитает его сам под гейтом.
  ok('файл не стал вложением-картинкой', drop.chips === 1, drop.chips)
  ok('и не открыл новый терминал', drop.panes === 4, drop.panes)

  // ==================================================================== inc-18
  // Панели в сайдбаре. До этого «Открытые» перечисляли ВКЛАДКИ: четыре панели
  // давали одну строку с припиской «· 4», и попасть мышью в конкретную панель
  // было нельзя.

  /** Строки панелей в сайдбаре — по их сессиям, в порядке списка. */
  const paneRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.zy-pane-row')].map((el) => el.getAttribute('data-session'))
    )
  /** Прямоугольники панелей на экране: размер и кому принадлежат. */
  const slots = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.zy-pane-slot')].map((el) => {
        const r = el.getBoundingClientRect()
        return {
          sid: el.querySelector('.zy-pane')?.getAttribute('data-session') ?? null,
          w: Math.round(r.width),
          h: Math.round(r.height),
          hidden: el.className.includes('--hidden')
        }
      })
    )
  const dump = () => page.evaluate(() => window.__zaryaDumpSessions())
  const creations = () => page.evaluate(() => window.__zaryaTermCreations())
  const paneInput = (sid) => `.zy-pane[data-session="${sid}"] .zy-agentbar-input`
  const closeFromSidebar = async (sid) => {
    // Кнопки строки появляются по наведению — как у человека.
    await page.hover(`.zy-pane-row[data-session="${sid}"]`)
    await page.waitForTimeout(250)
    await page.click(`.zy-pane-row[data-session="${sid}"] .zy-item-actions .zy-icon-btn:last-child`)
  }

  console.log('\n[8] В «Открытых» — панели, а не одна строка вкладки')
  // Сырой режим первой панели (раздел [5]) возвращаем: список смотрим в обычном.
  await page.evaluate((id) => window.__zaryaSetRawFor(id, false), ids[0])
  await page.waitForTimeout(600)
  const rows8 = await paneRows()
  const tabRows8 = await page.evaluate(() => document.querySelectorAll('.zy-tab-row').length)
  ok('четыре строки панелей', rows8.length === 4, rows8)
  ok('и ни одной свёрнутой вкладки (вкладка одна)', tabRows8 === 0, tabRows8)
  ok('строки указывают на те же сессии', rows8.every((s) => ids.includes(s)), rows8)

  const marks8 = await page.evaluate(() => ({
    onscreen: document.querySelectorAll('.zy-pane-row.zy-item--onscreen').length,
    focus: [...document.querySelectorAll('.zy-pane-row.zy-item--focus')].map((el) =>
      el.getAttribute('data-session')
    )
  }))
  const active8 = (await dump()).activeSessionId
  ok('«на экране» помечены все четыре', marks8.onscreen === 4, marks8)
  ok('«в фокусе» — ровно одна', marks8.focus.length === 1, marks8)
  ok('и это активная панель', marks8.focus[0] === active8, { marks8, active8 })

  console.log('\n[9] Клик по строке делает панель активной, набранное не теряется')
  // Печатаем в строку ТРЕТЬЕЙ панели и уходим кликом в ПЕРВУЮ.
  await page.click(paneInput(ids[2]))
  await page.keyboard.type('черновик третьей панели')
  await page.waitForTimeout(200)
  await page.click(`.zy-pane-row[data-session="${ids[0]}"]`)
  await page.waitForTimeout(700)
  const after9 = await page.evaluate(
    (list) => ({
      active: window.__zaryaDumpSessions().activeSessionId,
      framed: [...document.querySelectorAll('.zy-pane--focused')].map((el) =>
        el.getAttribute('data-session')
      ),
      focusRow: [...document.querySelectorAll('.zy-pane-row.zy-item--focus')].map((el) =>
        el.getAttribute('data-session')
      ),
      draft: document.querySelector(
        `.zy-pane[data-session="${list[2]}"] .zy-agentbar-input`
      )?.value,
      caretIn: document.activeElement?.closest('.zy-pane')?.getAttribute('data-session') ?? null
    }),
    ids
  )
  ok('панель стала активной', after9.active === ids[0], after9)
  ok('рамка на экране переехала к ней', after9.framed.join() === ids[0], after9)
  ok('строка «в фокусе» — та же панель', after9.focusRow.join() === ids[0], after9)
  ok('текст в чужой строке ввода уцелел', after9.draft === 'черновик третьей панели', after9)
  ok('курсор уехал в строку выбранной панели', after9.caretIn === ids[0], after9)

  console.log('\n[10] Закрыли одну из четырёх: раскладка, сессии, буферы')
  // Своя метка в каждую панель — по ней и проверяется, что буфер на месте.
  for (let i = 0; i < ids.length; i++) {
    await page.evaluate(([id, i]) => window.__zaryaRunShell(`echo БУФЕР-${i}`, id), [ids[i], i])
    await page.waitForTimeout(700)
  }
  await page.waitForTimeout(1500)
  const creationsBefore = await creations()
  await closeFromSidebar(ids[1])
  await page.waitForTimeout(2200)
  const after10 = await dump()
  const rows10 = await paneRows()
  const slots10 = (await slots()).filter((s) => !s.hidden)
  ok('панелей осталось три', after10.tabs[0].leaves.length === 3, after10.tabs)
  ok('строк в сайдбаре тоже три', rows10.length === 3, rows10)
  ok('закрытой панели в списке нет', !rows10.includes(ids[1]), rows10)
  ok('сессий стало на одну меньше', after10.sessions.length === 3, after10.sessions.length)
  // Три колонки: одинаковая ширина, полная высота.
  const widths10 = slots10.map((s) => s.w)
  const heights10 = slots10.map((s) => s.h)
  ok(
    'раскладка пересобралась в три колонки',
    slots10.length === 3 &&
      Math.max(...widths10) - Math.min(...widths10) <= 2 &&
      Math.max(...heights10) - Math.min(...heights10) <= 2,
    slots10
  )
  const creationsAfter = await creations()
  const survivors = ids.filter((id) => id !== ids[1])
  ok(
    'соседние терминалы НЕ пересозданы',
    survivors.every((id) => creationsAfter[id] === 1 && creationsBefore[id] === 1),
    { creationsBefore, creationsAfter }
  )
  const texts10 = await page.evaluate((list) => list.map((id) => window.__zaryaTermText(id)), ids)
  ok(
    'буферы соседних панелей на месте',
    [0, 2, 3].every((i) => new RegExp(`БУФЕР-${i}`).test(texts10[i] ?? '')),
    texts10.map((t, i) => `${i}:${(t ?? '').includes(`БУФЕР-${i}`)}`)
  )

  console.log('\n[11] Закрыли АКТИВНУЮ — фокус у соседней, и Enter уходит ей')
  // Гейт поднимаем в соседней панели: «фокус ушёл» проверяется тем, что один
  // Enter решает именно её карточку, а не чью-то ещё.
  const live = (await dump()).tabs[0].leaves
  const victim = live[1]
  const neighbour = live[2]
  await page.evaluate((sid) => window.__zaryaFocusPane(sid), neighbour)
  const convN = await page.evaluate(
    (sid) => window.__zaryaStartAgentIn?.('gemini', 'tool: поработай', sid),
    neighbour
  )
  await page.waitForTimeout(2000)
  // Строки ввода должны быть пустыми: Enter одобряет только пустое поле.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.zy-agentbar-input')) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set
      setter?.call(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await page.evaluate((sid) => window.__zaryaFocusPane(sid), victim)
  await page.waitForTimeout(400)
  const gateBefore11 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    convN
  )
  await page.evaluate((sid) => window.__zaryaCloseSession(sid), victim)
  await page.waitForTimeout(1800)
  const focus11 = await dump()
  ok('гейт соседней панели ждал решения', gateBefore11 > 0, gateBefore11)
  ok('фокус ушёл соседней панели, а не «никуда»', focus11.activeSessionId === neighbour, {
    active: focus11.activeSessionId,
    neighbour
  })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1600)
  const gateAfter11 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    convN
  )
  ok('Enter попал в неё — гейт решён', gateAfter11 === 0, gateAfter11)

  console.log('\n[12] Раскладку тянули руками — сама она не пересобирается')
  // Осталось две панели: тянем разделитель и закрываем одну из трёх… сперва
  // вернём третью, чтобы после закрытия было что проверять.
  await page.evaluate(() => window.__zaryaSplitActive('row'))
  await page.waitForTimeout(1600)
  const box = await page.evaluate(() => {
    const g = document.querySelector('.zy-gutter')
    const r = g.getBoundingClientRect()
    const host = document.querySelector('.zy-panes').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hostLeft: host.left, hostW: host.width }
  })
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x - 140, box.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(900)
  const dragged = (await slots()).filter((s) => !s.hidden).map((s) => s.w)
  ok('разделитель двигается мышью', Math.max(...dragged) - Math.min(...dragged) > 20, dragged)
  const leaves12 = (await dump()).tabs[0].leaves
  await page.evaluate((sid) => window.__zaryaCloseSession(sid), leaves12[leaves12.length - 1])
  await page.waitForTimeout(1800)
  const kept = (await slots()).filter((s) => !s.hidden).map((s) => s.w)
  ok(
    'после закрытия ручная раскладка осталась неравной',
    kept.length >= 2 && Math.max(...kept) - Math.min(...kept) > 20,
    kept
  )

  console.log('\n[13] Разворот панели на всю вкладку и обратно')
  const leaves13 = (await dump()).tabs[0].leaves
  const big = leaves13[0]
  const creations13 = await creations()
  await page.dblclick(`.zy-pane-row[data-session="${big}"]`)
  await page.waitForTimeout(900)
  const maxed = await slots()
  const hostBox = await page.evaluate(() => {
    const r = document.querySelector('.zy-panes').getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })
  const shown13 = maxed.filter((s) => !s.hidden)
  ok('видно ровно одну панель', shown13.length === 1 && shown13[0].sid === big, maxed)
  ok(
    'она занимает всю вкладку',
    Math.abs(shown13[0].w - hostBox.w) <= 2 && Math.abs(shown13[0].h - hostBox.h) <= 2,
    { shown: shown13[0], hostBox }
  )
  const onscreen13 = await page.evaluate(
    () => document.querySelectorAll('.zy-pane-row.zy-item--onscreen').length
  )
  ok('«на экране» помечена только она', onscreen13 === 1, onscreen13)
  const gutters13 = await page.evaluate(() => document.querySelectorAll('.zy-gutter').length)
  ok('тянуть в развёрнутом виде нечего — разделителей нет', gutters13 === 0, gutters13)
  await page.dblclick(`.zy-pane-row[data-session="${big}"]`)
  await page.waitForTimeout(900)
  const back13 = (await slots()).filter((s) => !s.hidden)
  ok('возврат к раскладке вернул соседей', back13.length === leaves13.length, back13)
  const guttersBack13 = await page.evaluate(() => document.querySelectorAll('.zy-gutter').length)
  ok('и разделители вернулись', guttersBack13 === leaves13.length - 1, {
    guttersBack13,
    leaves: leaves13.length
  })
  ok(
    'и ни один терминал не пересоздан',
    JSON.stringify(await creations()) === JSON.stringify(creations13),
    { before: creations13, after: await creations() }
  )

  console.log('\n[14] Вторая вкладка: развёрнута только активная')
  await page.evaluate(() => window.__zaryaNewTerminal())
  await page.waitForTimeout(2200)
  const state14 = await dump()
  const rows14 = await paneRows()
  const tabRows14 = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-tab-row')].map((el) => ({
      tab: el.getAttribute('data-tab'),
      title: el.querySelector('.zy-item-title')?.textContent ?? ''
    }))
  )
  const activeTab14 = state14.tabs.find((t) => t.id === state14.activeTabId)
  ok('панелями показана только активная вкладка', rows14.length === activeTab14.leaves.length, {
    rows14,
    activeTab14
  })
  ok('прежняя вкладка свернулась в одну строку', tabRows14.length === 1, tabRows14)
  ok('на строке виден счётчик панелей', / · \d/.test(tabRows14[0]?.title ?? ''), tabRows14)

  console.log('\n[15] Клик по свёрнутой вкладке разворачивает её')
  await page.click(`.zy-tab-row[data-tab="${tabRows14[0].tab}"]`)
  await page.waitForTimeout(1200)
  const state15 = await dump()
  const rows15 = await paneRows()
  const tabRows15 = await page.evaluate(() => document.querySelectorAll('.zy-tab-row').length)
  ok('прежняя вкладка стала активной', state15.activeTabId === tabRows14[0].tab, state15.activeTabId)
  ok(
    'её панели развернулись строками',
    rows15.length === state15.tabs.find((t) => t.id === state15.activeTabId).leaves.length,
    rows15
  )
  ok('а другая свернулась в одну строку', tabRows15 === 1, tabRows15)

  console.log('\n[16] Закрыли последнюю панель вкладки — вкладка ушла, борт жив')
  const other = state15.tabs.find((t) => t.id !== state15.activeTabId)
  await page.evaluate((sid) => window.__zaryaCloseSession(sid), other.leaves[0])
  await page.waitForTimeout(1800)
  const state16 = await dump()
  ok('вкладка исчезла вместе с последней панелью', state16.tabs.length === 1, state16.tabs.length)
  ok(
    'приложение живо и панели на месте',
    (await page.evaluate(() => document.querySelectorAll('.zy-pane').length)) ===
      state16.tabs[0].leaves.length,
    state16.tabs
  )

  console.log('\n[17] Несохранённый текст в строке — закрытие спрашивает')
  const alive17 = (await dump()).tabs[0].leaves
  const withText = alive17[0]
  await page.click(paneInput(withText))
  await page.keyboard.type('недописанный запрос агенту')
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    window.__asked = []
    window.__origConfirm = window.confirm
    window.confirm = (m) => {
      window.__asked.push(m)
      return false
    }
  })
  await closeFromSidebar(withText)
  await page.waitForTimeout(1200)
  const asked = await page.evaluate(() => window.__asked)
  const stillHere = (await dump()).tabs[0].leaves.includes(withText)
  ok('про потерю текста спросили', asked.length === 1 && /неотправленный текст/i.test(asked[0]), asked)
  ok('отказ оставил панель на месте', stillHere, alive17)
  await page.evaluate(() => {
    window.confirm = () => true
  })
  await closeFromSidebar(withText)
  await page.waitForTimeout(1500)
  ok('согласие закрыло панель', !(await dump()).tabs[0].leaves.includes(withText), withText)
  await page.evaluate(() => {
    window.confirm = window.__origConfirm
  })

  console.log('\n[18] Пятая панель уходит новой вкладкой, а не в никуда')
  while ((await dump()).tabs[0].leaves.length < 4) {
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(900)
  }
  const before18 = await dump()
  await page.evaluate(() => window.__zaryaSplitActive('row'))
  await page.waitForTimeout(1800)
  const after18 = await dump()
  const placed = new Set(after18.tabs.flatMap((t) => t.leaves))
  ok('вкладок стало больше', after18.tabs.length === before18.tabs.length + 1, {
    before: before18.tabs.length,
    after: after18.tabs.length
  })
  ok('ни в одной вкладке не больше четырёх панелей', after18.tabs.every((t) => t.leaves.length <= 4), after18.tabs.map((t) => t.leaves.length))
  ok(
    'ни одна сессия не осталась без панели',
    after18.sessions.every((s) => placed.has(s.id)),
    after18.sessions.filter((s) => !placed.has(s.id))
  )

  console.log('\n[19] Перетаскивание из сайдбара работает как раньше')
  const state19 = await dump()
  const target19 = state19.tabs.find((t) => t.id === state19.activeTabId).leaves[0]
  const donor = state19.tabs.find((t) => t.id !== state19.activeTabId)
  const moving = donor.leaves[0]
  const creations19 = await creations()
  await page.evaluate(
    ([moved, target]) => {
      const dt = new DataTransfer()
      dt.setData('application/x-zarya-session', moved)
      const pane = document.querySelector(`.zy-pane[data-session="${target}"]`)
      pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    [moving, target19]
  )
  await page.waitForTimeout(1600)
  const state19b = await dump()
  const hostTab = state19b.tabs.find((t) => t.leaves.includes(moving))
  ok(
    'перетащенная панель переехала к цели',
    !!hostTab && hostTab.leaves.includes(target19),
    state19b.tabs
  )
  ok(
    'её терминал при переезде не пересоздан',
    (await creations())[moving] === creations19[moving],
    { before: creations19[moving], after: (await creations())[moving] }
  )

  console.log('\n[20] В полную вкладку панель не переезжает — и об этом говорят')
  // Добиваем активную вкладку до четырёх панелей.
  for (let guard = 0; guard < 5; guard++) {
    const st = await dump()
    if (st.tabs.find((t) => t.id === st.activeTabId).leaves.length >= 4) break
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(900)
  }
  const state20 = await dump()
  const fullTab = state20.tabs.find((t) => t.id === state20.activeTabId)
  const outsider = state20.tabs.find((t) => t.id !== state20.activeTabId)?.leaves[0]
  if (!outsider) {
    ok('в соседней вкладке есть кого двигать', false, state20.tabs)
  } else {
    await page.evaluate(
      ([moved, target]) => {
        const dt = new DataTransfer()
        dt.setData('application/x-zarya-session', moved)
        document
          .querySelector(`.zy-pane[data-session="${target}"]`)
          .dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
          )
      },
      [outsider, fullTab.leaves[0]]
    )
    await page.waitForTimeout(1400)
    const state20b = await dump()
    const host20 = state20b.tabs.find((t) => t.leaves.includes(outsider))
    ok('панель осталась в своей вкладке', host20?.id !== fullTab.id, {
      host: host20?.id,
      fullTab: fullTab.id
    })
    ok(
      'в полной вкладке по-прежнему четыре панели',
      state20b.tabs.find((t) => t.id === fullTab.id)?.leaves.length === 4,
      state20b.tabs.map((t) => t.leaves.length)
    )
    const toasts = await page.evaluate(() =>
      [...document.querySelectorAll('.zy-toast')].map((el) => el.textContent ?? '')
    )
    ok('отказ объяснён вслух', toasts.some((t) => /четыре|4/i.test(t)), toasts)
  }

  console.log('\n[21] Проект из шапки тащится на КОНКРЕТНУЮ панель')
  // Проекты уехали в шапку (ede1b3f), и перетаскивание из сайдбара уехало вместе
  // с ними. Сценарий инкремента — «перетащил проекты из шапки на панель» —
  // держится на том, что пункт меню можно утащить.
  const state21 = await dump()
  const activeTab21 = state21.tabs.find((t) => t.id === state21.activeTabId)
  // Освобождаем место: в полной вкладке бросок ушёл бы новой вкладкой.
  while ((await dump()).tabs.find((t) => t.id === state21.activeTabId).leaves.length >= 4) {
    const t = (await dump()).tabs.find((x) => x.id === state21.activeTabId)
    await page.evaluate((sid) => window.__zaryaCloseSession(sid), t.leaves[t.leaves.length - 1])
    await page.waitForTimeout(1200)
  }
  const target21 = (await dump()).tabs.find((t) => t.id === state21.activeTabId).leaves[0]
  const before21 = (await dump()).tabs.find((t) => t.id === state21.activeTabId).leaves.length
  await page.evaluate(() => window.__zaryaAddProject('C:\\Windows'))
  await page.waitForTimeout(400)
  await page.click('.zy-titlebar-proj')
  await page.waitForTimeout(500)
  const dragged21 = await page.evaluate(async (target) => {
    const item = [...document.querySelectorAll('.zy-context-item')].find((el) => el.draggable)
    if (!item) return { ok: false, why: 'в меню нечего тащить' }
    const dt = new DataTransfer()
    item.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    // Ждём перерисовку: «меню спряталось» — это состояние React, а не то, что
    // происходит внутри самого обработчика.
    await new Promise((r) => setTimeout(r, 120))
    // Меню обязано УЙТИ С ГЛАЗ, но остаться в разметке: удалить узел, который
    // тащат, значит оборвать жест.
    const menu = item.closest('.zy-context-menu')
    const hidden = menu?.className.includes('--dragging') && !!menu.isConnected
    const pane = document.querySelector(`.zy-pane[data-session="${target}"]`)
    pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    item.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
    return { ok: true, carried: dt.getData('application/x-zarya-cwd'), hidden }
  }, target21)
  await page.waitForTimeout(2500)
  const after21 = await dump()
  const tab21 = after21.tabs.find((t) => t.id === state21.activeTabId)
  ok('пункт проекта в шапке можно тащить', dragged21.ok, dragged21)
  ok('и он несёт путь проекта', dragged21.carried === 'C:\\Windows', dragged21)
  ok('меню ушло с глаз, но жест не оборвало', dragged21.hidden === true, dragged21)
  const menuGone21 = await page.evaluate(() => document.querySelectorAll('.zy-context-menu').length)
  ok('после броска меню закрылось', menuGone21 === 0, menuGone21)
  ok('панель появилась в той же вкладке', tab21?.leaves.length === before21 + 1, {
    before: before21,
    after: tab21?.leaves.length
  })
  const newPane21 = tab21?.leaves.find((sid) => !activeTab21.leaves.includes(sid))
  const cwd21 = after21.sessions.find((s) => s.id === newPane21)?.cwd ?? ''
  ok('и открылась в папке проекта', /windows/i.test(cwd21), { newPane21, cwd21 })

  console.log('\n[22] Развёрнутая панель не прячет работу: деление, переезд, соседняя вкладка')
  // Находки ревью: разворот был состоянием ОКНА, и три пути его не согласовывали.
  // Итог был всегда один — живая панель, которой не видно, и Enter уходил ей.
  const st22 = await dump()
  const tabA = st22.tabs.find((t) => t.id === st22.activeTabId)
  while ((await dump()).tabs.find((t) => t.id === tabA.id).leaves.length > 2) {
    const t = (await dump()).tabs.find((x) => x.id === tabA.id)
    await page.evaluate((sid) => window.__zaryaCloseSession(sid), t.leaves[t.leaves.length - 1])
    await page.waitForTimeout(1200)
  }
  const pair = (await dump()).tabs.find((t) => t.id === tabA.id).leaves
  await page.dblclick(`.zy-pane-row[data-session="${pair[0]}"]`)
  await page.waitForTimeout(800)
  const shown22 = (await slots()).filter((s) => !s.hidden)
  ok('панель развернулась', shown22.length === 1 && shown22[0].sid === pair[0], shown22)
  // 1. Делим, не сворачивая: просили ещё панель — значит, просили увидеть раскладку.
  await page.evaluate(() => window.__zaryaSplitActive('row'))
  await page.waitForTimeout(1800)
  const afterSplit22 = await dump()
  const shownSplit = (await slots()).filter((s) => !s.hidden)
  const tabNow22 = afterSplit22.tabs.find((t) => t.id === tabA.id)
  ok(
    'после деления видно ВСЕ панели вкладки',
    shownSplit.length === tabNow22.leaves.length,
    { shown: shownSplit.map((s) => s.sid), leaves: tabNow22.leaves }
  )
  ok(
    'и активная панель — среди видимых',
    shownSplit.some((s) => s.sid === afterSplit22.activeSessionId),
    { active: afterSplit22.activeSessionId, shown: shownSplit.map((s) => s.sid) }
  )
  // 2. Двойной клик по строке ДРУГОЙ панели разворачивает ЕЁ, а не сворачивает всё.
  const first22 = tabNow22.leaves[0]
  const other22 = tabNow22.leaves.find((s) => s !== first22)
  await page.dblclick(`.zy-pane-row[data-session="${first22}"]`)
  await page.waitForTimeout(800)
  await page.dblclick(`.zy-pane-row[data-session="${other22}"]`)
  await page.waitForTimeout(900)
  const shown22b = (await slots()).filter((s) => !s.hidden)
  ok(
    '2×клик по соседней строке разворачивает ЕЁ',
    shown22b.length === 1 && shown22b[0].sid === other22,
    shown22b
  )
  ok(
    'развёрнутая панель — она же в фокусе',
    (await dump()).activeSessionId === other22,
    { active: (await dump()).activeSessionId, other22 }
  )
  // 3. Соседняя вкладка о чужом развороте ничего не знает.
  await page.evaluate(() => window.__zaryaNewTerminal())
  await page.waitForTimeout(1800)
  await page.evaluate(() => window.__zaryaSplitActive('row'))
  await page.waitForTimeout(1800)
  const st22c = await dump()
  const tabB = st22c.tabs.find((t) => t.id === st22c.activeTabId)
  const rowsB = await page.evaluate(() =>
    document.querySelectorAll('.zy-pane-row.zy-item--onscreen').length
  )
  const guttersB = await page.evaluate(() => document.querySelectorAll('.zy-gutter').length)
  ok('в соседней вкладке все панели помечены «на экране»', rowsB === tabB.leaves.length, {
    rowsB,
    leaves: tabB.leaves.length
  })
  ok('и разделители на месте', guttersB === tabB.leaves.length - 1, guttersB)
  const shownB = (await slots()).filter((s) => !s.hidden)
  ok(
    'видимые панели — ровно панели активной вкладки',
    shownB.length === tabB.leaves.length && shownB.every((s) => tabB.leaves.includes(s.sid)),
    { shown: shownB.map((s) => s.sid), leaves: tabB.leaves }
  )

  console.log('\n[23] Возврат в свёрнутую вкладку: Enter снова одобряет')
  // Переключение вкладки ставило курсор в скрытое поле xterm, и голый Enter
  // переставал одобрять гейт: рамка обещала «сюда уйдёт Enter», а он не уходил.
  const st23 = await dump()
  const tabAgain = st23.tabs.find((t) => t.id !== st23.activeTabId)
  const gateSid = tabAgain.activeSessionId
  const conv23 = await page.evaluate(
    (sid) => window.__zaryaStartAgentIn?.('gemini', 'tool: поработай', sid),
    gateSid
  )
  await page.waitForTimeout(2200)
  const creations23 = await creations()
  await page.click(`.zy-tab-row[data-tab="${tabAgain.id}"]`)
  await page.waitForTimeout(1200)
  const caret23 = await page.evaluate(() => ({
    pane: document.activeElement?.closest('.zy-pane')?.getAttribute('data-session') ?? null,
    isInput: (document.activeElement?.className ?? '').includes('zy-agentbar-input')
  }))
  ok('курсор попал в строку ввода активной панели', caret23.isInput, caret23)
  ok('и это панель той вкладки', caret23.pane === gateSid, { caret23, gateSid })
  ok(
    'переключение вкладки не пересоздало терминалы',
    JSON.stringify(await creations()) === JSON.stringify(creations23),
    { before: creations23, after: await creations() }
  )
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1600)
  const gate23 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    conv23
  )
  ok('Enter одобрил гейт после возврата во вкладку', gate23 === 0, gate23)

  console.log('\n[24] Спрашиваем про то, что теряется — и только про это')
  const st24 = await dump()
  const leaves24 = st24.tabs.find((t) => t.id === st24.activeTabId).leaves
  const withText24 = leaves24[0]
  const clean24 = leaves24[1]
  await page.click(paneInput(withText24))
  await page.keyboard.type('неотправленный запрос из первой панели')
  await page.waitForTimeout(200)
  // Уходим в ДРУГУЮ панель: закрываемая перестаёт быть активной — раньше тест
  // закрывал ровно ту, где стоял курсор, и зеркалирование черновика по своей
  // панели (а не по активной) оставалось непроверенным.
  await page.click(`.zy-pane-row[data-session="${clean24}"]`)
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    window.__asked = []
    window.__origConfirm = window.confirm
    window.confirm = (m) => {
      window.__asked.push(m)
      return false
    }
  })
  await closeFromSidebar(withText24)
  await page.waitForTimeout(1000)
  const asked24 = await page.evaluate(() => window.__asked)
  ok(
    'спросили про текст НЕ активной панели',
    asked24.length === 1 && /неотправленный запрос из первой панели/.test(asked24[0]),
    asked24
  )
  ok('и панель осталась', (await dump()).tabs.some((t) => t.leaves.includes(withText24)), withText24)
  // Панель без потерь закрывается молча — иначе вопрос обесценится.
  await page.evaluate(() => {
    window.__asked = []
  })
  await closeFromSidebar(clean24)
  await page.waitForTimeout(1500)
  const askedClean = await page.evaluate(() => window.__asked)
  ok('панель без потерь закрылась без вопросов', askedClean.length === 0, askedClean)
  await page.evaluate(() => {
    window.confirm = window.__origConfirm
  })

  console.log('\n[25] Гейт не остаётся висеть после закрытия панели')
  const st25 = await dump()
  const sid25 = st25.tabs.find((t) => t.id === st25.activeTabId).leaves[0]
  const conv25 = await page.evaluate(
    (sid) => window.__zaryaStartAgentIn?.('gemini', 'tool: поработай', sid),
    sid25
  )
  await page.waitForTimeout(2200)
  const before25 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    conv25
  )
  await page.evaluate(() => {
    window.__asked = []
    window.__origConfirm = window.confirm
    window.confirm = (m) => {
      window.__asked.push(m)
      return true
    }
  })
  await closeFromSidebar(sid25)
  await page.waitForTimeout(2000)
  const asked25 = await page.evaluate(() => window.__asked)
  const after25 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    conv25
  )
  const imgs25 = await page.evaluate((sid) => (window.__zaryaPendingImages(sid) ?? []).length, sid25)
  ok('гейт висел', before25 > 0, before25)
  ok('перед закрытием предупредили про ожидающее решение', /ждёт решения/i.test(asked25[0] ?? ''), asked25)
  ok('после закрытия ничего не «ждёт решения»', after25 === 0, after25)
  ok('вложения закрытой панели убраны', imgs25 === 0, imgs25)
  await page.evaluate(() => {
    window.confirm = window.__origConfirm
  })

  console.log('\n[26] Набранное переживает уход строки с экрана')
  // Полноэкранная программа сама включает сырой режим, и строка ввода при этом
  // размонтируется. Раньше набранный запрос исчезал вместе с ней — молча.
  const st26 = await dump()
  const sid26 = st26.tabs.find((t) => t.id === st26.activeTabId).leaves[0]
  await page.evaluate((sid) => window.__zaryaFocusPane(sid), sid26)
  await page.waitForTimeout(300)
  await page.click(paneInput(sid26))
  await page.keyboard.type('запрос, набранный до vim')
  await page.waitForTimeout(200)
  await page.evaluate((sid) => window.__zaryaSetRawFor(sid, true), sid26)
  await page.waitForTimeout(700)
  const hidden26 = await page.evaluate(
    (sid) => !document.querySelector(`.zy-pane[data-session="${sid}"] .zy-agentbar-input`),
    sid26
  )
  await page.evaluate((sid) => window.__zaryaSetRawFor(sid, false), sid26)
  await page.waitForTimeout(700)
  const restored26 = await page.evaluate(
    (sid) =>
      document.querySelector(`.zy-pane[data-session="${sid}"] .zy-agentbar-input`)?.value ?? null,
    sid26
  )
  ok('строка действительно уходила с экрана', hidden26 === true, hidden26)
  ok('и набранное вернулось на место', restored26 === 'запрос, набранный до vim', restored26)
  // Убираем за собой: иначе следующий раздел получит чужой вопрос при закрытии.
  await page.evaluate((sid) => {
    const el = document.querySelector(`.zy-pane[data-session="${sid}"] .zy-agentbar-input`)
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, '')
    el?.dispatchEvent(new Event('input', { bubbles: true }))
  }, sid26)
  await page.waitForTimeout(300)

  console.log('\n[27] Режим строки принадлежит своей панели')
  // Общий на окно режим означал бы: агент, начавший ход в соседней панели,
  // переключает чип ЗДЕСЬ, и Enter уводит команду терминала в модель.
  const st27 = await dump()
  const tab27 = st27.tabs.find((t) => t.id === st27.activeTabId)
  while ((await dump()).tabs.find((t) => t.id === tab27.id).leaves.length < 2) {
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(1600)
  }
  const [pa, pb] = (await dump()).tabs.find((t) => t.id === tab27.id).leaves
  await page.evaluate((sid) => window.__zaryaSetRawFor(sid, false), pa)
  await page.evaluate((sid) => window.__zaryaSetRawFor(sid, false), pb)
  await page.waitForTimeout(500)
  const modeBefore = await page.evaluate((sid) => window.__zaryaBarModeFor(sid), pa)
  // В соседней панели начинается ход агента — авто-переключение сработает ТАМ.
  await page.evaluate((sid) => window.__zaryaStartAgentIn?.('gemini', 'привет', sid), pb)
  await page.waitForTimeout(2500)
  const modeAfter = await page.evaluate((sid) => window.__zaryaBarModeFor(sid), pa)
  const modeNeighbour = await page.evaluate((sid) => window.__zaryaBarModeFor(sid), pb)
  ok('режим соседней панели переключился сам', modeNeighbour === 'gemini', modeNeighbour)
  ok('а режим своей панели не тронут', modeAfter === modeBefore, { modeBefore, modeAfter })

  console.log('\n[28] История ↑ не достаёт команду чужой панели')
  await page.click(paneInput(pa))
  await page.keyboard.type('echo ИСТОРИЯ-ПЕРВОЙ')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await page.click(paneInput(pb))
  await page.waitForTimeout(300)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(400)
  const recalled = await page.evaluate(
    (sid) =>
      document.querySelector(`.zy-pane[data-session="${sid}"] .zy-agentbar-input`)?.value ?? '',
    pb
  )
  ok('в чужой панели ↑ не подставил команду', !/ИСТОРИЯ-ПЕРВОЙ/.test(recalled), recalled)
  await page.click(paneInput(pa))
  await page.waitForTimeout(300)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(400)
  const own = await page.evaluate(
    (sid) =>
      document.querySelector(`.zy-pane[data-session="${sid}"] .zy-agentbar-input`)?.value ?? '',
    pa
  )
  ok('в своей — подставил', /ИСТОРИЯ-ПЕРВОЙ/.test(own), own)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.zy-agentbar-input')) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await page.waitForTimeout(300)

  console.log('\n[29] Esc из чужого поля не прерывает работу панели')
  // Esc, которым бросают поиск сессий в сайдбаре, уходил активной панели: мог
  // отклонить гейт и забрать отправленное сообщение из памяти агента.
  const conv29 = await page.evaluate(
    (sid) => window.__zaryaStartAgentIn?.('gemini', 'tool: поработай', sid),
    pa
  )
  await page.waitForTimeout(2200)
  const gate29 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    conv29
  )
  await page.click('.zy-sidebar-search .zy-input')
  await page.keyboard.type('поиск')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  const gateAfter29 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    conv29
  )
  ok('гейт висел', gate29 > 0, gate29)
  ok('Esc в поиске сайдбара его не тронул', gateAfter29 === gate29, { gate29, gateAfter29 })
  // А из своей строки — по-прежнему отклоняет.
  await page.evaluate(() => {
    const el = document.querySelector('.zy-sidebar-search .zy-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click(paneInput(pa))
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  const gateOwn29 = await page.evaluate(
    (c) => (window.__zaryaConvById(c)?.pendingTools ?? []).filter((t) => !t.settled).length,
    conv29
  )
  ok('Esc из своей строки гейт отклонил', gateOwn29 === 0, gateOwn29)

  console.log('\n[30] Панель выносится в свой рабочий стол — не убивая процесс')
  // Обратный жест к перетаскиванию панели на панель. До него убрать лишний CLI с
  // разделённого экрана можно было только закрыв его, то есть убив процесс.
  const st30 = await dump()
  const tab30 = st30.tabs.find((t) => t.id === st30.activeTabId)
  while ((await dump()).tabs.find((t) => t.id === tab30.id).leaves.length < 3) {
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(1600)
  }
  const leaves30 = (await dump()).tabs.find((t) => t.id === tab30.id).leaves
  const away = leaves30[1]
  await page.evaluate(([id, i]) => window.__zaryaRunShell(`echo ВЫНОС-${i}`, id), [away, 1])
  await page.waitForTimeout(1400)
  const creations30 = await creations()
  const tabsBefore30 = (await dump()).tabs.length
  // Как человек: тащим строку панели в пустое место списка.
  await page.evaluate((sid) => {
    const dt = new DataTransfer()
    const row = document.querySelector(`.zy-pane-row[data-session="${sid}"]`)
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    const body = document.querySelector('.zy-sidebar-body')
    body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, away)
  await page.waitForTimeout(1800)
  const st30b = await dump()
  const home30 = st30b.tabs.find((t) => t.id === tab30.id)
  const fresh30 = st30b.tabs.find((t) => t.leaves.length === 1 && t.leaves[0] === away)
  ok('панель ушла из прежнего стола', !home30.leaves.includes(away), home30.leaves)
  ok('и получила свой', !!fresh30 && fresh30.id !== tab30.id, st30b.tabs)
  ok('столов стало на один больше', st30b.tabs.length === tabsBefore30 + 1, {
    was: tabsBefore30,
    now: st30b.tabs.length
  })
  ok('процесс жив: сессия на месте', st30b.sessions.some((s) => s.id === away), away)
  ok('терминал не пересоздан', (await creations())[away] === creations30[away], {
    before: creations30[away],
    after: (await creations())[away]
  })
  const text30 = await page.evaluate((id) => window.__zaryaTermText(id), away)
  ok('и экран панели цел', /ВЫНОС-1/.test(text30), text30.slice(-60))
  ok('человек остался в своём столе', st30b.activeTabId === tab30.id, st30b.activeTabId)
  const shown30 = (await slots()).filter((s) => !s.hidden)
  ok(
    'на экране остались только панели своего стола',
    shown30.length === home30.leaves.length && shown30.every((s) => home30.leaves.includes(s.sid)),
    { shown: shown30.map((s) => s.sid), leaves: home30.leaves }
  )
  ok(
    'вынесенная панель видна в списке свёрнутой строкой',
    (await page.evaluate(
      (id) => !!document.querySelector(`.zy-tab-row[data-tab="${id}"]`),
      fresh30?.id
    )) === true,
    fresh30?.id
  )

  console.log('\n[31] Рабочий стол можно назвать')
  const head31 = await page.evaluate(() => {
    const el = document.querySelector('.zy-desk-row')
    return { exists: !!el, title: el?.querySelector('.zy-item-title')?.textContent ?? '' }
  })
  ok('у развёрнутого стола есть заголовок', head31.exists, head31)
  // Подпись по умолчанию собрана из панелей, а не взята у активной.
  const names31 = (await dump()).sessions
    .filter((s) => home30.leaves.includes(s.id))
    .map((s) => s.title)
  ok(
    'подпись собрана из имён панелей',
    names31.slice(0, 2).every((n) => head31.title.includes(n)),
    { head: head31.title, names31 }
  )
  await page.evaluate(() => {
    window.__origPrompt = window.prompt
    window.prompt = () => 'СБОРКА 0.6'
  })
  await page.dblclick('.zy-desk-row')
  await page.waitForTimeout(700)
  const renamed31 = await page.evaluate(
    () => document.querySelector('.zy-desk-row .zy-item-title')?.textContent ?? ''
  )
  ok('имя, заданное руками, встало в заголовок', /СБОРКА 0\.6/.test(renamed31), renamed31)
  // И оно же — в строке свёрнутой вкладки, когда уйдём в другой стол.
  await page.click(`.zy-tab-row[data-tab="${fresh30.id}"]`)
  await page.waitForTimeout(1200)
  const collapsed31 = await page.evaluate(
    (id) =>
      document.querySelector(`.zy-tab-row[data-tab="${id}"] .zy-item-title`)?.textContent ?? '',
    tab30.id
  )
  ok('и в свёрнутой строке тоже', /СБОРКА 0\.6/.test(collapsed31), collapsed31)
  await page.evaluate(() => {
    window.prompt = window.__origPrompt
  })
  await page.click(`.zy-tab-row[data-tab="${tab30.id}"]`)
  await page.waitForTimeout(1000)

  console.log('\n[32] Панель хватается за свою шапку')
  const st32 = await dump()
  const home32 = st32.tabs.find((t) => t.id === st32.activeTabId)
  const grip32 = await page.evaluate((sid) => {
    const grip = document.querySelector(`.zy-pane[data-session="${sid}"] .zy-pane-grip`)
    if (!grip) return { ok: false }
    const dt = new DataTransfer()
    grip.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    return { ok: true, carried: dt.getData('application/x-zarya-session'), draggable: grip.draggable }
  }, home32.leaves[0])
  ok('шапка панели — ручка', grip32.ok && grip32.draggable === true, grip32)
  ok('и несёт свою сессию', grip32.carried === home32.leaves[0], grip32)

  console.log('\n[33] Окно ни на что не жалуется')
  // Ключи списка панелей, размонтирование, гонки эффектов — всё это React
  // проговаривает в консоли раньше, чем сломается видимое.
  const noise = complaints.filter((t) => !/Autofill|DevTools|Electron Security/i.test(t))
  ok('ни ошибок, ни предупреждений', noise.length === 0, noise.slice(0, 4))

  console.log(`\n[panes] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
