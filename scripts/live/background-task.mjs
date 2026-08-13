/**
 * Фоновые задачи: увести субагента в фон и не ждать его.
 *
 *   ZARYA_LIVE=1 node scripts/live/background-task.mjs   # настоящий Claude Code
 *
 * ТОЛЬКО ЖИВОЙ. `query.backgroundTasks` — вызов в чужой процесс, и фейковый
 * драйвер о нём не знает ничего: проверять на нём значило бы проверять свою же
 * заглушку.
 *
 * ГЛАВНОЕ ЗДЕСЬ — ВРЕМЯ. На просьбу увести в фон движок отвечает `ok` и
 * `matched` ОДИНАКОВО и когда уводит, и когда нет; различие видно только по
 * часам: ход отпускает сразу или дожидается конца работы. Ровно этим и
 * выяснилось, что для команды оболочки `backgroundTasks` не работает (73 с при
 * работе на 60 с), а для субагента работает (6 с).
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
  skip('фоновые задачи', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

/** Сколько работает подопытная задача. Ход обязан отпустить ЗАМЕТНО раньше. */
const РАБОТА_С = 60

const stand = makeStand({ 'README.md': '# Стенд фоновых задач\n' })
note('проект:', stand)
const { app, page, userData } = await launchZarya({ work: stand })

const state = (page, convId) =>
  page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return { background: c?.background ?? null, streaming: c?.streaming === true }
  }, convId)

try {
  section('[1] Запускаем субагента с долгой работой')
  /*
   * Отправляем и НЕ ЖДЁМ конца: весь смысл в том, чтобы застать ход идущим.
   * `askAgent` из харнесса ждёт завершения и потому здесь не годится.
   *
   * Работа субагента — `node` с таймером, а не `sleep`: движок запрещает
   * `sleep` в foreground своей же политикой и отказывается его выполнять.
   */
  const conv = await page.evaluate(
    ([e, p]) => window.__zaryaStartAgent?.(e, p),
    ['claude-code', 'привет']
  )
  await page.waitForTimeout(1000)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), conv)
  await waitIdle(page, conv)
  await page.evaluate(
    (p) => window.__zaryaFollowUp?.(p),
    'Запусти субагента general-purpose через инструмент Task с поручением: выполнить через Bash ' +
      'команду node -e "setTimeout(()=>process.exit(0),60000)" и затем ответить словом готово. ' +
      'Дождись субагента.'
  )

  let появился = false
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    if ((await page.$$('.zy-mf-wave-row')).length > 0) {
      появился = true
      break
    }
  }
  ok('субагент виден в волне', появился)
  const btn = await page.$('.zy-mf-wave-bgbtn')
  ok('у него есть кнопка «В фон»', !!btn)
  await shot(page, 'bg-1-running')

  section('[2] Нажимаем — и ход отпускает сразу, а не по концу работы')
  const t0 = Date.now()
  if (btn) await btn.click()
  await waitIdle(page, conv, 150_000)
  const ждали = Math.round((Date.now() - t0) / 1000)
  note('ход отпустило через, с:', ждали)
  /*
   * Порог с запасом: работа идёт минуту, и «меньше 25 секунд» нельзя получить,
   * дождавшись её. Одинаковый ответ движка в обоих случаях делает время
   * единственным честным признаком.
   */
  ok('ход отпустило сразу, а не по концу работы', ждали < 25, {
    ждали,
    'работа идёт': РАБОТА_С
  })
  await shot(page, 'bg-2-backgrounded')

  section('[3] Задача осталась жить и названа движком')
  const after = await state(page, conv)
  note('набор фоновых:', JSON.stringify(after.background))
  ok('движок прислал набор фоновых задач', Array.isArray(after.background), after.background)
  ok('в наборе есть живая задача', (after.background ?? []).length > 0, after.background)
  ok(
    'у каждой задачи есть опознаваемое имя',
    (after.background ?? []).every((t) => !!t.taskId),
    after.background
  )
} finally {
  await app.close()
  cleanup([stand, userData])
}

finish()
