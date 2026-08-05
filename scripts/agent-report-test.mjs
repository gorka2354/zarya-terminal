/**
 * Два конца хода, у которых раньше не было голоса.
 *
 * ПЕРВЫЙ — обрыв. Движок вправе закончить ход, ничего не сказав: сработал хук,
 * модель отказалась отвечать, ход прервали снаружи. Заря на это не показывала
 * НИЧЕГО — точки «агент отвечает» просто гасли. На экране это неотличимо от
 * зависшей программы, и единственный вывод, который человек мог сделать, —
 * неверный.
 *
 * ВТОРОЙ — сжатие контекста. Движок время от времени сворачивает историю
 * разговора в пересказ. После этого агент помнит суть, но не буквальные слова —
 * и без отметки выглядит это как внезапная потеря памяти посреди беседы.
 *
 * Здесь проверяется, что оба конца видны и что видны они ПО-РАЗНОМУ: обрыв —
 * строкой с пометкой, сжатие — чертой поперёк ленты, а пока сжатие идёт — своей
 * строкой работы, а не «агент отвечает…» (что было бы неправдой).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-report-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-reportw-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
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
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1100, 700)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.waitForTimeout(600)

  console.log('\n[1] Оборванный ход говорит, что он оборван')
  await page.evaluate(() => window.__zaryaAskAgent?.('оборви ход', 'codex'))
  await page.waitForTimeout(1600)
  const notice = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-notice')
    if (!el) return null
    return {
      cls: el.className,
      mark: el.querySelector('.zy-mf-notice-mark')?.textContent ?? '',
      text: el.querySelector('.zy-mf-notice-text')?.textContent ?? ''
    }
  })
  ok('строка движка на экране', !!notice, notice)
  ok('сказано, что ход прерван', /прерван/.test(notice?.text ?? ''), notice?.text)
  ok('уровень различим по виду', /zy-mf-notice-warn/.test(notice?.cls ?? ''), notice?.cls)

  // Главное в этом прогоне: молчаливого конца больше нет. Ход был НЕМЫМ (фейк
  // не сказал ни слова) — и всё равно на экране осталось объяснение.
  const answers = await page.evaluate(
    () => document.querySelectorAll('.zy-mf-answer').length
  )
  ok('ответа агента и правда не было', answers === 0, answers)
  const spinning = await page.evaluate(() => !!document.querySelector('.zy-mf-typing'))
  ok('точки «отвечает» погасли, а не висят', !spinning)

  if (shots) await page.screenshot({ path: join(shots, 'report-abort.png') })

  console.log('\n[2] Пока сжатие идёт — видно, что оно идёт')
  await page.evaluate(() => window.__zaryaAskAgent?.('сжатие контекста', 'codex'))
  await page.waitForTimeout(800) // между «running» (300мс) и «done» (1400мс)
  const during = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-typing-compact')
    return el ? { text: el.textContent ?? '', spinner: !!el.querySelector('.zy-mf-spinner') } : null
  })
  ok('строка работы на экране', !!during, during)
  ok('со своим словом, а не «агент отвечает»', /сворачива/i.test(during?.text ?? ''), during?.text)
  ok('и с крутилкой — работа видна', during?.spinner === true, during)
  if (shots) await page.screenshot({ path: join(shots, 'report-compacting.png') })

  console.log('\n[3] После сжатия остаётся отметка с числами движка')
  await page.waitForTimeout(1600)
  const after = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-compact')
    if (!el) return null
    return {
      what: el.querySelector('.zy-mf-compact-what')?.textContent ?? '',
      size: el.querySelector('.zy-mf-compact-size')?.textContent ?? '',
      lines: el.querySelectorAll('.zy-mf-compact-line').length
    }
  })
  ok('отметка на экране', !!after, after)
  ok('сказано, что разговор свёрнут', /сверн|свёрн/i.test(after?.what ?? ''), after?.what)
  // Числа — движка. Своей арифметики здесь нет и быть не должно: «примерно»
  // хуже молчания, потому что выглядит как знание.
  ok('показан размер до и после', after?.size === '128k → 21k', after?.size)
  ok('это черта поперёк ленты, а не карточка', after?.lines === 2, after?.lines)
  // Движок объявляет конец сжатия ДВАЖДЫ — состоянием и границей с числами.
  // Черта об одном событии должна остаться одна, иначе лента врёт о том,
  // сколько раз агент забыл разговор.
  const marks = await page.evaluate(() => document.querySelectorAll('.zy-mf-compact').length)
  ok('отметка ровно одна, а не две', marks === 1, marks)
  // Строка работы обязана исчезнуть: оставшийся спиннер сказал бы, что сжатие
  // всё ещё идёт, когда оно уже кончилось.
  const stillSpinning = await page.evaluate(
    () => !!document.querySelector('.zy-mf-typing-compact')
  )
  ok('строка работы убралась', !stillSpinning)
  if (shots) await page.screenshot({ path: join(shots, 'report-compacted.png') })

  console.log('\n[4] Длинный вывод раскрывается прямо в ленте')
  await page.evaluate(() => window.__zaryaAskAgent?.('покажи вывод', 'codex'))
  await page.waitForTimeout(1800)
  const heads = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-outcome-head')].map((e) => e.textContent ?? '')
  )
  ok('у длинного вывода появилась кнопка', heads.length === 1, heads)
  ok('в свёрнутом виде видна первая строка', /2 failed/.test(heads[0] ?? ''), heads[0])
  // Короткий вывод кнопки НЕ получает: стрелка там обещала бы продолжение,
  // которого нет. Это главная проверка пункта, а не мелочь.
  const shortDone = await page.evaluate(
    () =>
      [...document.querySelectorAll('.zy-mf-tool-done')].filter(
        (e) => !e.classList.contains('zy-mf-outcome-head')
      ).length
  )
  ok('у короткого вывода кнопки нет', shortDone === 1, shortDone)

  await page.click('.zy-mf-outcome-head')
  await page.waitForTimeout(400)
  const out = await page.evaluate(
    () => document.querySelector('.zy-mf-outcome-out')?.textContent ?? ''
  )
  ok('раскрытый вывод целиком', /agentPlan[.]test[.]ts/.test(out), out.slice(0, 120))
  ok('и причина падения видна', /ожидалось/.test(out), out.slice(0, 120))
  if (shots) await page.screenshot({ path: join(shots, 'report-output.png') })

  await page.click('.zy-mf-outcome-head')
  await page.waitForTimeout(300)
  const closed = await page.evaluate(() => !document.querySelector('.zy-mf-outcome-out'))
  ok('закрывается тем же нажатием', closed)

  console.log(`\n[agent-report] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
