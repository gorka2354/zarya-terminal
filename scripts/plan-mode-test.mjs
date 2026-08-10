/**
 * Режим плана и потеря памяти агентом.
 *
 * РЕЖИМ ПЛАНА. Драйвер принимал `permissionMode: 'plan'` с самого начала, но
 * входа в него не было: `nativeGateOpts()` возвращал `'default'` безусловно, и
 * единственный способ попросить агента «сперва расскажи» — написать это словами
 * и надеяться. Здесь проверяется, что чип и правда меняет то, что уезжает
 * драйверу, а не только вид на экране.
 *
 * Главное здесь — не вид чипа, а СОДЕРЖИМОЕ хода. Чип показывает намерение;
 * поведение агента определяет то, что дошло до драйвера, и разойтись эти двое
 * могут молча. Поэтому прогон читает журнал запусков фейка.
 *
 * ПОТЕРЯ ПАМЯТИ. Движок умеет начать беседу заново — от `/clear`, от выхода из
 * плана, от новой сессии. Заря об этом не знала и продолжала показывать ленту,
 * которой агент уже не помнит, а следующий ход уходил с прежним номером сессии:
 * интерфейс утверждал, что память на месте, когда её нет.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-plan-mode-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-plan-modew-'))
const startLog = join(userData, 'starts.jsonl')
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

/** Чем на самом деле кончился ход — из журнала запусков драйвера. */
const starts = () =>
  existsSync(startLog)
    ? readFileSync(startLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_FAKE_START_LOG: startLog,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1100, 760)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null, barMode: 'codex' }))
  await page.waitForTimeout(800)

  console.log('\n[1] Чип режима плана есть — и он не третье состояние замка')
  const chips = await page.evaluate(() => ({
    plan: !!document.querySelector('.zy-agentbar-plan'),
    gate: !!document.querySelector('.zy-agentbar-bypass'),
    planOn: !!document.querySelector('.zy-agentbar-plan--on')
  }))
  ok('чип плана на экране', chips.plan === true, chips)
  ok('замок остался отдельно', chips.gate === true, chips)
  ok('и по умолчанию план выключен', chips.planOn === false, chips)

  console.log('\n[2] Включённый план виден и запирает замок')
  await page.click('.zy-agentbar-plan')
  await page.waitForTimeout(400)
  const on = await page.evaluate(() => ({
    planOn: !!document.querySelector('.zy-agentbar-plan--on'),
    // Спрашивать не о чем: агент не выполняет ничего. Живой замок предлагал бы
    // ослабить гейт, который и так закрыт наглухо.
    gateLocked: !!document.querySelector('.zy-agentbar-bypass--locked'),
    gateOn: !!document.querySelector('.zy-agentbar-bypass--on')
  }))
  ok('чип горит', on.planOn === true, on)
  ok('замок заперт и не зовёт нажимать', on.gateLocked === true, on)
  ok('и автопилот не показан включённым', on.gateOn === false, on)
  await page.screenshot({ path: join(shots || tmpdir(), 'plan-mode-on.png') }).catch(() => {})

  console.log('\n[3] Драйверу и правда уезжает plan')
  // Это главная проверка. Чип показывает НАМЕРЕНИЕ; поведение агента задаёт то,
  // что дошло до драйвера, и разойтись они могут молча.
  await page.evaluate(() => window.__zaryaAskAgent?.('проверь режим', 'codex'))
  await page.waitForTimeout(1400)
  const first = starts().at(-1)
  ok('ход ушёл с permissionMode=plan', first?.permissionMode === 'plan', first)
  // «Выполняй без спроса» и «не выполняй ничего» вместе не значат ничего.
  ok('и автопилот снят', first?.bypass === false, first)

  console.log('\n[4] Автопилот и план не включаются вместе')
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  const bothTried = await page.evaluate(() => {
    const b = document.querySelector('.zy-agentbar-bypass')
    return { disabled: b?.disabled === true }
  })
  ok('замок недоступен, пока план включён', bothTried.disabled === true, bothTried)

  console.log('\n[5] Выключенный план возвращает обычную работу')
  await page.click('.zy-agentbar-plan')
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__zaryaAskAgent?.('проверь режим ещё раз', 'codex'))
  await page.waitForTimeout(1400)
  const second = starts().at(-1)
  ok('ход ушёл с permissionMode=default', second?.permissionMode === 'default', second)
  const off = await page.evaluate(() => ({
    planOn: !!document.querySelector('.zy-agentbar-plan--on'),
    gateLocked: !!document.querySelector('.zy-agentbar-bypass--locked')
  }))
  ok('чип погас', off.planOn === false, off)
  ok('и замок снова живой', off.gateLocked === false, off)

  console.log('\n[6] Карточка выхода из плана называет себя словами')
  // У настоящего движка вход этого вызова ПУСТ: план лежит в его файле. Без
  // отдельной ветки карточка выводила голое «ExitPlanMode» — то есть просила
  // согласия на непонятное, а согласие тут крупное: после него агент работает.
  await page.click('.zy-agentbar-plan')
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__zaryaAskAgent?.('выход из плана', 'codex'))
  await page.waitForTimeout(1400)
  // Пока гейт ждёт решения, команда живёт в РАСКРЫТОМ блоке, а не в свёрнутом
  // заголовке: заголовок узкий, и одобрять по обрезанной строке нельзя.
  const card = await page.evaluate(
    () =>
      document.querySelector('.zy-mf-tool-full')?.textContent ??
      document.querySelector('.zy-mf-tool-cmd')?.textContent ??
      ''
  )
  ok('карточка названа по-человечески', /перейти от плана к работе/.test(card), card)
  ok('и голого имени инструмента нет', !/ExitPlanMode/.test(card), card)
  // «До конца сессии» здесь означало бы: впредь агент выходит из плана САМ. Весь
  // смысл режима в том, что человек видит план и соглашается; раздав такое
  // разрешение однажды, он оставил бы себе чип, который ничего не защищает.
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-actions button')].map((b) => b.textContent ?? '')
  )
  ok('правила «до конца сессии» не предлагают', !btns.some((b) => /СЕССИИ/i.test(b)), btns)
  await page.screenshot({ path: join(shots || tmpdir(), 'plan-mode-exit.png') }).catch(() => {})

  console.log('\n[7] Согласие возвращает агента к работе')
  // Без этого «переходи к работе» ничего бы не меняло: агент остался бы
  // связанным, и каждая правка упиралась бы в отказ. Интерфейс пообещал бы
  // действие и не дал его.
  await page.click('.zy-mf-btn-run')
  await page.waitForTimeout(600)
  const after = await page.evaluate(() => !!document.querySelector('.zy-agentbar-plan--on'))
  ok('режим плана снят сам', after === false)

  console.log('\n[8] Агент забыл разговор — об этом сказано')
  // ВТОРЫМ ходом в той же беседе: только так видно, что лента не стёрлась —
  // новая беседа и так была бы пустой, и проверка не значила бы ничего.
  await page.evaluate(() => window.__zaryaAskAgent?.('первое слово — КЕДР', 'codex'))
  await page.waitForTimeout(1200)
  // Строк ввода на экране несколько (у каждой панели своя); нужна ВИДИМАЯ.
  await page.locator('.zy-agentbar-input >> visible=true').first().click()
  await page.keyboard.type('забудь всё')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1400)
  const reset = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-reset')
    return el ? { text: el.textContent ?? '', lines: el.querySelectorAll('.zy-mf-reset-line').length } : null
  })
  ok('черта на экране', !!reset, reset)
  ok('и сказано, что выше он не помнит', /не помнит/.test(reset?.text ?? ''), reset?.text)
  // Ленту НЕ стираем: записи выше — человека, и терять их из-за чужой
  // забывчивости нельзя.
  const kept = await page.evaluate(
    () => [...document.querySelectorAll('.zy-mf-user')].map((e) => e.textContent ?? '')
  )
  ok('прежний ход человека на месте', kept.some((k) => /КЕДР/.test(k)), kept)
  await page.screenshot({ path: join(shots || tmpdir(), 'plan-mode-reset.png') }).catch(() => {})

  console.log('\n[9] Где движок так не умеет — чипа нет вовсе')
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'gemini' }))
  await page.waitForTimeout(700)
  const noPlan = await page.evaluate(() => !!document.querySelector('.zy-agentbar-plan'))
  ok('чипа режима плана нет', noPlan === false)

  console.log(`\n[plan-mode] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
