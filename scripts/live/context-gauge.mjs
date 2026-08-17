/**
 * Заполнение контекста на настоящем Claude Code (inc-44).
 *
 *   ZARYA_LIVE=1 node scripts/live/context-gauge.mjs
 *
 * ТОЛЬКО ЖИВОЙ, и повод конкретный. Здесь стояла своя арифметика: сумма
 * `input + cache_read + cache_creation` из итога хода. Ревью прогнало реальный
 * ход и показало цену — на четырёх шагах сумма дала 150K там, где занято было
 * 38K: чип показал бы 75% вместо 19%. На длинном ходе сумма перевалила бы окно,
 * и подсказка сказала бы «480K из 200K» — занято больше, чем всего.
 *
 * Подставной драйвер этого поймать не мог: он отдаёт зашитые числа. Проверить
 * можно только настоящим движком и только ходом с НЕСКОЛЬКИМИ вызовами
 * инструментов — на одном шаге ошибка не видна.
 */
import {
  LIVE, cleanup, finish, launchZarya, makeStand, note, ok, section, skip, waitIdle
} from '../lib/live-harness.mjs'

if (!LIVE) {
  skip('заполнение контекста', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд контекста\n' })
const { app, page, userData } = await launchZarya({ work: stand })

const ctx = (page, id) =>
  page.evaluate((c) => window.__zaryaConvById?.(c)?.context ?? null, id)

try {
  section('[1] Ход с НЕСКОЛЬКИМИ вызовами инструментов')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  const a = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'Выполни ТРИ отдельных вызова Bash: echo один, затем echo два, затем echo три. После каждого дождись результата. Ответь словом «готово».',
        s
      ),
    [sid]
  )
  await page.waitForTimeout(1200)
  // Автопилот: иначе прогон встанет на карточке разрешения, нажать которую некому.
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), a)
  await waitIdle(page, a, 300_000)
  const c1 = await ctx(page, a)
  const amb = await page.evaluate(() => window.__zaryaDumpUi?.()?.agentContext ?? null)
  note('после многошагового хода — беседа:', JSON.stringify(c1))
  note('общее состояние окна:', JSON.stringify(amb))
  ok('движок отчитался о заполнении', !!c1 && typeof c1.pct === 'number', c1)

  section('[2] Занято НЕ БОЛЬШЕ, чем всего')
  /*
   * Главная проверка. Прежняя арифметика складывала обращения хода, и сумма
   * росла с каждым вызовом инструмента — на длинном ходе она переваливала окно.
   */
  ok('токенов не больше окна', (c1?.tokens ?? 0) <= (c1?.window ?? 0), c1)
  ok('процент в пределах здравого смысла', (c1?.pct ?? 0) > 0 && (c1?.pct ?? 0) <= 100, c1)

  section('[3] Число похоже на правду, а не на сумму обращений')
  /*
   * Свежий разговор из одного короткого хода не может занимать половину окна:
   * там системный промпт, инструменты и три строчки. Прежняя арифметика на
   * четырёх шагах давала 75%.
   */
  note('процент:', c1?.pct, '· токенов:', c1?.tokens, 'из', c1?.window)
  ok('свежий разговор не занял половину окна', (c1?.pct ?? 100) < 50, c1)
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanup([stand, userData])
}

finish()
