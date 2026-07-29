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

try {
  const page = await app.firstWindow()
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

  console.log(`\n[panes] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
