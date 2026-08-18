/**
 * Знает ли агент, где он работает (inc-45).
 *
 *   ZARYA_LIVE=1 node scripts/live/self-id.mjs
 *
 * ТОЛЬКО ЖИВОЙ: проверяется чужая голова, а не наш код. Живая проверка ранее
 * показала, что агент описывает себя обобщённо — «терминальный агент в
 * десктопном приложении-оркестраторе» — и не знает ни про ленту, ни про блоки
 * команд, ни про то, чего у него НЕТ. Последнее важнее прочего: не зная
 * границы, модель охотно обещает человеку кнопки, которых не существует.
 */
import {
  LIVE, cleanup, finish, launchZarya, makeStand, note, ok, section, skip, waitIdle
} from '../lib/live-harness.mjs'

if (!LIVE) {
  skip('визитка Зари', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд визитки\n' })
const { app, page, userData } = await launchZarya({ work: stand })

const text = (page, id) =>
  page.evaluate((c) => String(window.__zaryaConvById?.(c)?.lastAnswer ?? ''), id)

try {
  section('[1] Агент знает, где он работает')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  const a = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'В каком приложении ты сейчас работаешь? Ответь одним предложением, ничего не запуская.',
        s
      ),
    [sid]
  )
  await waitIdle(page, a, 240_000)
  const t1 = await text(page, a)
  note('ответ:', JSON.stringify(t1.slice(-200)))
  ok('называет Зарю по имени', /зар[ья]|zarya/i.test(t1), t1.slice(-200))

  section('[2] Знает, что человек видит рядом')
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Что человек видит на экране, пока ты работаешь? Ответь двумя предложениями, ничего не запуская.'
      ),
    [a]
  )
  await waitIdle(page, a, 240_000)
  const t2 = await text(page, a)
  note('ответ:', JSON.stringify(t2.slice(-260)))
  ok(
    'знает про ленту хода и карточки вызовов',
    /карточ|лент|feed|card|одобр|approv/i.test(t2),
    t2.slice(-260)
  )

  section('[3] ГЛАВНОЕ: знает, чего у него НЕТ')
  /*
   * Без этой границы модель сочиняет Заре возможности и обещает их человеку от
   * её имени. Спрашиваем прямо о том, чего у неё точно нет как инструмента.
   */
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Можешь ли ТЫ САМ откатить файлы к моему предыдущему ходу — вызвать такую функцию? Ответь честно, одним предложением, ничего не запуская.'
      ),
    [a]
  )
  await waitIdle(page, a, 240_000)
  const t3 = await text(page, a)
  note('ответ:', JSON.stringify(t3.slice(-260)))
  ok(
    'честно говорит, что сам этого не может',
    /не мог|нет|не уме|cannot|can't|не могу/i.test(t3),
    t3.slice(-260)
  )
  ok(
    'и не выдумывает себе такой инструмент',
    !/вызову|сейчас откачу|выполняю откат/i.test(t3),
    t3.slice(-260)
  )
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanup([stand, userData])
}

finish()
