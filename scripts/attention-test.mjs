/**
 * Внимание человека: кто ждёт, кто работает, и когда звать.
 *
 * Модель Зари — четыре панели, у каждой свой агент. Её цена: чем лучше работает
 * автопилот, тем чаще человек не знает, КТО из четверых встал и ждёт нажатия.
 * Раньше «работает» и «ждёт тебя» считались одним состоянием и подписывались
 * одним словом, а позвать человека было нечем — во всём коде не было ни одного
 * уведомления.
 *
 * Прогон проверяет обе половины: что состояния разведены и что зов приходит
 * ровно тогда, когда человек не смотрит.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-attention-'))
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

  /*
   * Ловим РЕШЕНИЕ позвать, а не рисование системного окна.
   *
   * Патчим прототип Notification (главный процесс импортирует класс из
   * 'electron', поэтому подмена глобальной переменной ничего бы не дала) и
   * flashFrame у самого окна.
   */
  await app.evaluate(({ Notification, BrowserWindow }) => {
    globalThis.__calls = { notes: [], flashes: 0 }
    // Служба уведомлений есть не везде: на Linux под xvfb (то есть в CI) её нет
    // вовсе, и Notification.isSupported() отвечает false — код честно
    // ограничивается миганием окна и до показа не доходит. Умеет ли ОС рисовать
    // всплывашку, проверяет не этот прогон; он проверяет РЕШЕНИЕ позвать — тот
    // ли повод, тот ли текст, один ли раз. Поэтому признак поддержки
    // подменяется так же, как ниже подменяется «человек смотрит».
    const reallySupported = Notification.isSupported()
    Notification.isSupported = () => true
    const origShow = Notification.prototype.show
    Notification.prototype.show = function patched() {
      globalThis.__calls.notes.push({ title: this.title, body: this.body })
      // Настоящий показ — только там, где служба действительно есть. Иначе
      // вызов уходит в пустоту, а на некоторых сборках Linux и в ошибку.
      return reallySupported ? origShow.call(this) : undefined
    }
    for (const w of BrowserWindow.getAllWindows()) {
      const orig = w.flashFrame.bind(w)
      w.flashFrame = (on) => {
        if (on) globalThis.__calls.flashes++
        return orig(on)
      }
    }
  })

  console.log('\n[1] «Ждёт тебя» и «работает» — разные состояния')
  await page.evaluate(() => window.__zaryaSplitActive?.('row'))
  await page.waitForTimeout(1200)
  const sids = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves)
  ok('панелей две', sids.length === 2, sids.length)

  await page.evaluate((ids) => ids.forEach((s) => window.__zaryaSetPaneBarMode?.(s, 'codex')), sids)
  await page.evaluate((ids) => {
    // «tool» поднимает гейт, «slow» просто думает долго.
    window.__zaryaStartAgentIn?.('codex', 'run a tool please', ids[0])
    window.__zaryaStartAgentIn?.('codex', 'slow think about it', ids[1])
  }, sids)
  await page.waitForTimeout(2500)

  const panes = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-pane')].map((el) => ({
      session: el.getAttribute('data-session'),
      waiting: el.className.includes('--waiting')
    }))
  )
  ok('панель с гейтом помечена ждущей', panes.find((p) => p.session === sids[0])?.waiting === true, panes)
  ok('панель, которая просто работает, — нет', panes.find((p) => p.session === sids[1])?.waiting === false, panes)

  const subs = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-item-sub')].map((e) => e.textContent.trim())
  )
  ok('в сайдбаре сказано «ждёт вас»', subs.some((x) => x.includes('ждёт вас')), subs)
  ok('и отдельно «выполняется»', subs.some((x) => x === 'выполняется'), subs)

  const head = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.zy-section-head-text')]
    return heads.map((h) => h.textContent.trim())
  })
  ok('заголовок раздела считает ждущих', head.some((h) => h.includes('1 ждёт')), head)

  console.log('\n[2] Зов приходит только когда человек не смотрит')
  // Окно в фокусе — звать некуда.
  const focused = await app.evaluate(() => globalThis.__calls.notes.length)
  ok('пока окно в фокусе, уведомлений нет', focused === 0, focused)

  /*
   * Отобрать фокус у окна из прогона нельзя: на Windows blur() без другого окна
   * ничего не меняет, и window.isFocused() остаётся true. Поэтому подменяем сам
   * признак «человек смотрит» с обеих сторон — проверяется решение звать, а не
   * умение операционной системы переключать окна.
   */
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].isFocused = () => false
  })
  await page.evaluate(() => {
    document.hasFocus = () => false
  })
  await page.waitForTimeout(400)
  await page.evaluate((ids) => window.__zaryaStartAgentIn?.('codex', 'run a tool again', ids[1]), sids)
  await page.waitForTimeout(2500)

  const called = await app.evaluate(() => globalThis.__calls)
  ok('когда окно не в фокусе — позвали', called.notes.length >= 1, called.notes.length)
  ok('и подсветили окно в панели задач', called.flashes >= 1, called.flashes)
  ok(
    'в уведомлении сказано, какая панель и что спрашивают',
    !!called.notes[0] && !!called.notes[0].body && called.notes[0].body.length > 3,
    called.notes[0]
  )

  // Тот же гейт не должен звонить второй раз.
  const before = called.notes.length
  await page.waitForTimeout(1500)
  const after = await app.evaluate(() => globalThis.__calls.notes.length)
  ok('один гейт — один зов, а не поток', after === before, { before, after })
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временный профиль */
  }
}

console.log(`\n[attention] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
