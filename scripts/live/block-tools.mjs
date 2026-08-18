/**
 * Агент читает команды человека по своей воле (inc-46).
 *
 *   ZARYA_LIVE=1 node scripts/live/block-tools.mjs
 *
 * ТОЛЬКО ЖИВОЙ: инструменты объявляет движок, и увидеть их можно лишь его
 * глазами. Хвост консоли едет сам, но он короткий по устройству — несколько
 * последних команд с обрезанным выводом. Когда упало что-то длинное, агент
 * видел хвост и просил человека переслать то, что лежит в этой же панели.
 */
import {
  LIVE, cleanup, finish, launchZarya, makeStand, note, ok, section, skip, waitIdle
} from '../lib/live-harness.mjs'

if (!LIVE) {
  skip('инструменты блоков', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд блоков\n' })
const { app, page, userData } = await launchZarya({
  work: stand,
  // Инструменты появляются вместе с записками: тумблер один на весь сервер.
  settings: { ai: { paneMessages: true } }
})

const answer = (page, id) =>
  page.evaluate((c) => String(window.__zaryaConvById?.(c)?.lastAnswer ?? ''), id)

try {
  section('[1] Панель с командами человека')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  const seeded = await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 4, 4), sid)
  ok('команды в консоли есть', seeded > 0, { seeded })

  section('[2] Агент сам смотрит, что запускал человек')
  /*
   * Автопилот включаем ДО первого хода, на самой панели.
   *
   * Эти два вызова, в отличие от записок, идут через карточку разрешения — так
   * задумано. Прогон нажать её не может, и включённый ПОСЛЕ старта автопилот
   * опаздывает: первый же вызов успевает встать на карточке, ход замирает, а
   * прогон читает пустой ответ и винит инструмент.
   */
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  await page.waitForTimeout(400)
  const a = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'Позови инструмент mcp__zarya__list_blocks и перечисли, что он вернул. Ничего больше не делай.',
        s
      ),
    [sid]
  )
  await waitIdle(page, a, 300_000)
  // Ход считается законченным чуть раньше, чем последний кусок ответа ложится
  // в ленту: без паузы прогон читает пустоту и винит инструмент.
  await page.waitForTimeout(2500)
  const t1 = await answer(page, a)
  note('ответ:', JSON.stringify(t1.slice(-320)))
  ok('инструмент вернул команды человека', /git log|npm test|git status/i.test(t1), t1.slice(-320))

  section('[3] И дочитывает вывод, которого нет в хвосте')
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Возьми id самой первой команды из того списка и позови mcp__zarya__read_block с ним. Скажи, что было в её выводе. Ничего больше не делай.'
      ),
    [a]
  )
  await waitIdle(page, a, 300_000)
  await page.waitForTimeout(2500)
  const t2 = await answer(page, a)
  note('ответ:', JSON.stringify(t2.slice(-320)))
  ok(
    'прочитал вывод именно той команды',
    /vite|built in|modules transformed/i.test(t2),
    t2.slice(-320)
  )

  section('[4] Чужую панель через эти инструменты не прочитать')
  /*
   * Инструмент читает консоль ТОЙ беседы, из которой его позвали. Иначе вышел
   * бы новый способ заглянуть в соседний проект мимо всего, что для этого есть.
   */
  const sid2 = await page.evaluate(() => window.__zaryaNewTerminal?.())
  await page.waitForTimeout(2000)
  await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 2, 2), sid2)
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Позови mcp__zarya__list_blocks ещё раз. Сколько команд он вернул на этот раз? Ответь числом.'
      ),
    [a]
  )
  await waitIdle(page, a, 300_000)
  await page.waitForTimeout(2500)
  const t3 = await answer(page, a)
  note('ответ:', JSON.stringify(t3.slice(-200)))
  ok('видит только свою панель, а не соседнюю', !/6|шест/i.test(t3), t3.slice(-200))
  section('[4а] Поиск по своей консоли — вместо чтения всего подряд')
  /*
   * Без поиска «где я это видел» стоило серии read_block, и каждый тащил в
   * контекст тысячи знаков ради одной строки. Проверяем ровно это: агент
   * находит нужный блок ОДНИМ вызовом и цитирует совпавшую строку.
   */
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Позови mcp__zarya__list_blocks с contains "modules transformed". Назови команду найденного блока и процитируй совпавшую строку. Больше ничего не вызывай.'
      ),
    [a]
  )
  await waitIdle(page, a, 300_000)
  await page.waitForTimeout(2500)
  const t5 = await answer(page, a)
  note('ответ:', JSON.stringify(t5.slice(-320)))
  ok('нашёл нужную команду поиском', /npm run build/i.test(t5), t5.slice(-320))
  ok('и процитировал совпавшую строку', /modules transformed/i.test(t5), t5.slice(-320))

  section('[5] Сказал «консоль не давать» — инструментов нет вовсе')
  /*
   * Ноль в настройке подачи значит «мою консоль агенту не давать». Оставить
   * инструмент и спрашивать разрешение на каждый вызов значило бы уговаривать
   * после отказа — и платить за него токенами в каждом запросе.
   */
  await page.evaluate(() => window.__zaryaSetTailBlocks?.(0))
  await page.waitForTimeout(600)
  const sid3 = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 3, 3), sid3)
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid3)
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  const d = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'Есть ли у тебя инструмент mcp__zarya__list_blocks? Ответь «да» или «нет» и ничего не вызывай.',
        s
      ),
    [sid3]
  )
  await waitIdle(page, d, 300_000)
  await page.waitForTimeout(2500)
  const t4 = await answer(page, d)
  note('ответ:', JSON.stringify(t4.slice(-220)))
  ok('инструмента у агента нет', /нет|no\b|отсут/i.test(t4), t4.slice(-220))
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanup([stand, userData])
}

finish()
