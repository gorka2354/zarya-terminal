/**
 * Хвост консоли на настоящем Claude Code (inc-42).
 *
 *   ZARYA_LIVE=1 node scripts/live/shell-tail.mjs
 *
 * ТОЛЬКО ЖИВОЙ. Всё остальное проверяет `scripts/shell-tail-test.mjs`; здесь —
 * единственный вопрос, на который фейковый драйвер ответить не может: ВИДИТ ЛИ
 * настоящий агент команды человека и отвечает ли по ним, не спрашивая заново.
 *
 * Раньше ответ был «нет»: блоки собирались, но до движка не доезжали вовсе.
 * Прогон проверяет не «текст уехал» (это дело юнитов), а то, что агент им
 * реально пользуется — и заодно меряет, во что это обошлось.
 */
import {
  LIVE,
  cleanup,
  finish,
  launchZarya,
  makeStand,
  note,
  ok,
  section,
  shot,
  skip,
  waitIdle
} from '../lib/live-harness.mjs'

if (!LIVE) {
  skip('хвост консоли', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд хвоста консоли\n' })
note('проект:', stand)
const { app, page, userData } = await launchZarya({
  work: stand,
  settings: { ai: { contextBlocks: 3 } }
})

const dump = (page, id) =>
  page.evaluate((cid) => {
    const c = window.__zaryaConvById?.(cid)
    return {
      text: String(c?.text ?? ''),
      tails: c?.shellTails ?? [],
      error: c?.error ?? null
    }
  }, id)

/** Заполнение контекстного окна прямо сейчас — им и меряем прибавку. */
const ctxTokens = (page) =>
  page.evaluate(() => window.__zaryaDumpUi?.()?.agentContext?.tokens ?? 0)

try {
  section('[1] Панель с командами в консоли')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  /*
   * Блоки засеваем хуком, а не настоящими командами: живой прогон и так долгий,
   * а вопрос здесь не в том, умеет ли Заря ловить OSC-последовательности (это
   * проверено отдельно), а в том, доедут ли собранные блоки до движка.
   */
  const seeded = await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 4, 4), sid)
  ok('команды в консоли есть', seeded > 0, { seeded })

  section('[2] Агент ОТВЕЧАЕТ по командам, которых ему не пересказывали')
  /*
   * Вопрос намеренно без единой подробности: ни имени команды, ни вывода. Если
   * блоки не доехали, агенту нечем ответить — он попросит рассказать, что было.
   */
  const a = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'Какую команду я запускал последней и чем она кончилась? Ответь одной строкой, ничего не запуская.',
        s
      ),
    [sid]
  )
  await waitIdle(page, a, 240_000)
  const got = await dump(page, a)
  note('ответ агента:', JSON.stringify(got.text.slice(-300)))
  note('хвост:', JSON.stringify(got.tails))
  ok('к ходу приложен хвост', got.tails.length === 1, got.tails)
  /*
   * Ищем ЛЮБУЮ из уехавших команд, а не заранее выбранную.
   *
   * Первая версия требовала дословно `git log` — и упала на прогоне, где модель
   * сочла «последней» соседнюю команду из того же хвоста. Обе достоверны, обеих
   * не было в вопросе, спор идёт не о них: проверяется, что агент знает то,
   * чего ему не рассказывали. Требовать от модели конкретного выбора значило бы
   * завести мигающий тест, а он хуже отсутствующего.
   */
  const named = (got.tails[0]?.used ?? []).filter((cmd) =>
    got.text.includes(String(cmd).split(' ')[0])
  )
  note('команды из хвоста, названные агентом:', JSON.stringify(named))
  ok('агент назвал настоящую команду из хвоста', named.length > 0, {
    text: got.text.slice(-300),
    used: got.tails[0]?.used
  })
  ok('и не попросил пересказать, что было', !/какую именно|не вижу|уточните/i.test(got.text), {
    text: got.text.slice(-300)
  })
  await shot(page, 'tail-1-answer')

  section('[3] Сколько это весит')
  /*
   * ЦЕНУ В ТОКЕНАХ ЭТИМ ПРИБОРОМ НЕ ИЗМЕРИТЬ, и прогон говорит это вслух.
   *
   * Две попытки, обе неверные. Первая снимала прибавку между ходами ОДНОЙ
   * беседы и назвала ценой хвоста 1910 токенов — в прибавку входил весь
   * предыдущий обмен, ошибка почти восьмикратная. Вторая сравнивала две свежие
   * беседы: 41483 против 41702, разница ОТРИЦАТЕЛЬНАЯ. Причина видна из самих
   * чисел: базовый контекст движка — под сорок тысяч токенов (системный промпт,
   * состав инструментов, память проекта), и восемьсот символов хвоста тонут в
   * его естественном разбросе.
   *
   * Поэтому меряем то, что знаем точно, — РАЗМЕР В СИМВОЛАХ и соблюдение
   * потолка. Это ровно тот случай, ради которого Заря не считает токены сама:
   * назвать цифру, за которую никто не отвечает, хуже, чем её не называть.
   */
  const ASK = 'Скажи «да» и больше ничего.'

  const withId = await page.evaluate(
    ([s, q]) => window.__zaryaStartAgentIn?.('claude-code', q, s),
    [sid, ASK]
  )
  await waitIdle(page, withId, 240_000)
  const withState = await dump(page, withId)
  const chars = withState.tails[0]?.chars ?? 0
  const ctx = await ctxTokens(page)
  note('размер хвоста:', chars, 'символов · весь контекст движка:', ctx, 'токенов')
  note('доля хвоста в контексте — доли процента; отдельной строкой она не видна')
  ok('хвост уложился в потолок', chars > 0 && chars <= 5000, { chars })
  ok('беседа с хвостом отработала без ошибки', !withState.error, withState.error)

  await page.evaluate(() => window.__zaryaSetTailBlocks?.(0))
  await page.waitForTimeout(600)
  const offId = await page.evaluate(
    ([s, q]) => window.__zaryaStartAgentIn?.('claude-code', q, s),
    [sid, ASK]
  )
  await waitIdle(page, offId, 240_000)
  const off = await dump(page, offId)

  section('[4] Выключенная настройка выключает подачу у настоящего движка')
  ok('хвоста нет вовсе', off.tails.length === 0, off.tails)
  const d = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'Какую команду я запускал последней? Ответь одной строкой, ничего не запуская.',
        s
      ),
    [sid]
  )
  await waitIdle(page, d, 240_000)
  const blind = await dump(page, d)
  note('ответ без хвоста:', JSON.stringify(blind.text.slice(-260)))
  // Обратная сторона той же правды: без хвоста агент действительно не знает.
  ok(
    'и агент честно не знает команды',
    !/git log --oneline|npm test -- --watch/i.test(blind.text),
    blind.text.slice(-260)
  )
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanup([stand, userData])
}

finish()
