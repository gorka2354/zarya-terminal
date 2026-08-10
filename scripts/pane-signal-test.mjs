/**
 * Терминал слушается человека (inc-22).
 *
 * Четыре места, где Заря вела себя не как терминал, и все четыре проверяются на
 * живом окне, а не на предикате:
 *
 * 1. Ctrl+C в строке ввода прерывает КОМАНДУ — вывод перестаёт расти. Раньше
 *    байта `\x03` не отправлял никто, и `ping` из этой же строки останавливался
 *    только щелчком в терминал.
 * 2. Пока команда идёт, закрытие панели спрашивает и НАЗЫВАЕТ команду. Тумблер
 *    «Подтверждать закрытие при работающем процессе» до этого дня не читал никто.
 * 3. Выключенный тумблер молчит — вопрос, который задают всегда, не значит ничего.
 * 4. Многострочная вставка спрашивает на ЛЮБОМ пути, включая браузерный `paste`
 *    (Ctrl+V, меню, средняя кнопка) — раньше вопрос знал только Ctrl+Shift+V.
 * 5. Однострочная вставка не спрашивает ни о чём.
 * 6. Файл, бро́шенный в терминал, не уносит человека в новую вкладку.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-signal-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'shell'), sid)
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- [1] Ctrl+C
  console.log('\n[1] Ctrl+C в строке ввода прерывает живую команду')
  // Команда набирается и отправляется КАК ЧЕЛОВЕКОМ: путь «строка ввода → pty»
  // и есть предмет проверки.
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('ping -n 30 127.0.0.1')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4000)
  const growing = await page.evaluate((s) => window.__zaryaTermText?.(s)?.length ?? 0, sid)
  await page.waitForTimeout(2500)
  const grown = await page.evaluate((s) => window.__zaryaTermText?.(s)?.length ?? 0, sid)
  ok('команда идёт — вывод растёт', grown > growing, { growing, grown })

  // Каретка снова в строке — именно оттуда клавиша раньше не значила ничего.
  await page.click('.zy-agentbar-input')
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(1500)
  const afterStop = await page.evaluate((s) => window.__zaryaTermText?.(s)?.length ?? 0, sid)
  await page.waitForTimeout(3000)
  const settled = await page.evaluate((s) => window.__zaryaTermText?.(s)?.length ?? 0, sid)
  ok('после Ctrl+C вывод перестал расти', settled === afterStop, { afterStop, settled })
  // Для кадра — сырой режим: в блочном сам терминал не показан, и на снимке не
  // было бы видно ни `ping`, ни `^C`, ради которых кадр и делается.
  if (shots) {
    await page.evaluate((s) => window.__zaryaSetRawFor?.(s, true), sid)
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(shots, 'pane-signal-ctrlc.png') })
    await page.evaluate((s) => window.__zaryaSetRawFor?.(s, false), sid)
    await page.waitForTimeout(500)
  }

  // Блоки — признак того, что shell-интеграция в этом окружении жива: без её
  // отметок Заря не знает ни о начале команды, ни о её имени, и проверки ниже
  // проверяли бы не код, а тишину.

  // ------------------------------------------------------ [2] и [3] вставка
  console.log('\n[2] Многострочная вставка спрашивает на браузерном пути')
  await page.evaluate(() => {
    window.__asked = []
    window.__origConfirm = window.confirm
    window.confirm = (m) => {
      window.__asked.push(m)
      return false
    }
  })
  const firePaste = async (text) =>
    page.evaluate((txt) => {
      window.__asked = []
      const el = document.querySelector('.zy-term')
      if (!el) return 'no-term'
      const dt = new DataTransfer()
      dt.setData('text/plain', txt)
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      el.dispatchEvent(ev)
      return ev.defaultPrevented ? 'prevented' : 'passed'
    }, text)

  const multi = await firePaste('git status\nrm -rf build\n')
  const askedPaste = await page.evaluate(() => window.__asked)
  ok('спросили про многострочную вставку', askedPaste.length === 1, askedPaste)
  ok('вставка остановлена до ответа', multi === 'prevented', multi)

  console.log('\n[3] Однострочная вставка не спрашивает')
  const single = await firePaste('git status')
  const askedSingle = await page.evaluate(() => window.__asked)
  ok('вопроса нет', askedSingle.length === 0, askedSingle)
  ok('вставка идёт своим путём', single === 'passed', single)

  // ------------------------------------------------------------- [4] перенос
  console.log('\n[4] Файл, брошенный в панель, вставляет путь')
  /*
   * Бросаем В ТУ ТОЧКУ, куда попадёт мышь, а не в узел, найденный селектором.
   *
   * Первая версия прогона диспатчила событие прямо на `.zy-term` — и была
   * зелёной при полностью нерабочей фиче: в блочном режиме лента лежит
   * непрозрачным слоем поверх терминала, мышь до него не доходит, и обработчик
   * висел там, куда человек попасть не может. Проверка, обходящая хит-тест,
   * проверяет не то, что делает человек.
   */
  const tabsBefore = await page.evaluate(() => window.__zaryaDumpSessions?.().tabs.length ?? 0)
  const dropResult = await page.evaluate(() => {
    const pane = document.querySelector('.zy-pane')
    if (!pane) return { err: 'no-pane' }
    const r = pane.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const target = document.elementFromPoint(x, y)
    if (!target) return { err: 'no-target' }
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'note.txt', { type: 'text/plain' }))
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }
    target.dispatchEvent(new DragEvent('dragover', opts))
    const ev = new DragEvent('drop', opts)
    target.dispatchEvent(ev)
    return { under: target.className || target.tagName, handled: ev.defaultPrevented }
  })
  await page.waitForTimeout(1000)
  const tabsAfter = await page.evaluate(() => window.__zaryaDumpSessions?.().tabs.length ?? 0)
  ok('бросок перехвачен панелью', dropResult.handled === true, dropResult)
  ok('вкладок столько же', tabsAfter === tabsBefore, { tabsBefore, tabsAfter })
  // Синтетический File не имеет пути на диске (webUtils вернёт пусто), поэтому
  // текста в строке не ждём — проверяем ровно то, что доказуемо: событие поймано
  // здесь и наверх не ушло.

  // ------------------------------------------- [5] вопрос про живую команду
  // Закрывающие проверки идут последними: они уносят панель, а вместе с ней и
  // терминал, на котором стоят проверки выше.
  console.log('\n[5] Закрытие панели с работающей командой спрашивает')
  /*
   * Фазу и имя команды задаём отметками, а не живой оболочкой: прогон запускает
   * приложение из `out/`, где скрипты shell-интеграции рядом не лежат, и ждать
   * от неё `OSC 133` бессмысленно. Проверяем то, что и должны, — реакцию Зари на
   * отметку «команда пошла» и на имя команды в ленте.
   */
  await page.evaluate((s) => window.__zaryaTermWrite?.(s, '\x1b]133;C\x07'), sid)
  await page.evaluate((s) => window.__zaryaSeedRunningBlock?.(s, 'building…', 'npm run build'), sid)
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    window.__asked = []
  })
  await page.evaluate((s) => window.__zaryaClosePaneAsking?.(s), sid)
  await page.waitForTimeout(1200)
  const asked = await page.evaluate(() => window.__asked)
  ok('вопрос задан', asked.length === 1, asked)
  ok('вопрос называет команду', /npm run build/.test(asked[0] ?? ''), asked)
  const alive = await page.evaluate(
    (s) => !!window.__zaryaDumpSessions?.().sessions.find((x) => x.id === s),
    sid
  )
  ok('отказ оставил панель на месте', alive)

  console.log('\n[6] Ctrl+C у пустого приглашения отбрасывает набранное')
  // Раньше клавиша в этом случае не давала НИКАКОГО признака работы: `^C` рисует
  // оболочка, а в блочном режиме терминал накрыт лентой. Человек видел ровно то
  // же, что и до нажатия, — то есть «не работает».
  await page.evaluate((s) => window.__zaryaTermWrite?.(s, '\x1b]133;D;0\x07'), sid)
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('черновик который не отправляли')
  const before7 = await page.inputValue('.zy-agentbar-input')
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(500)
  const after7 = await page.inputValue('.zy-agentbar-input')
  ok('текст был', before7.includes('черновик'), before7)
  ok('строка очищена', after7 === '', after7)

  console.log('\n[7] Выключенный тумблер не спрашивает')
  await page.evaluate(() => window.zarya.settings.set({ terminal: { confirmCloseRunning: false } }))
  await page.waitForTimeout(700)
  await page.evaluate(() => {
    window.__asked = []
  })
  await page.evaluate((s) => window.__zaryaClosePaneAsking?.(s), sid)
  await page.waitForTimeout(1500)
  const asked6 = await page.evaluate(() => window.__asked)
  ok('вопроса нет', asked6.length === 0, asked6)
  await page.evaluate(() => {
    window.confirm = window.__origConfirm
  })
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  process.exit(fail ? 1 : 0)
}
