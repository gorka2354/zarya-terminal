/**
 * Откат ЧЕРЕЗ несколько ходов и отказ во время работы.
 *
 *   node scripts/live/rewind-deep.mjs              # фейк
 *   ZARYA_LIVE=1 node scripts/live/rewind-deep.mjs # настоящий Claude Code
 *
 * Основной сценарий (rewind-basic) проверяет один ход. Здесь — то, ради чего
 * откат вообще нужен: «верни всё, что он наделал за последние три хода». И
 * заодно случай, где откат обязан ОТКАЗАТЬ: пока идёт ход, файлы трогать
 * нельзя — иначе они уедут из-под работающего инструмента.
 */
import {
  LIVE,
  askAgent,
  cleanup,
  convState,
  editPrompt,
  finish,
  followUp,
  launchZarya,
  makeStand,
  note,
  ok,
  openRewind,
  readWork,
  section,
  shot,
  skip,
  text,
  waitDone,
  waitForGo
} from '../lib/live-harness.mjs'

const stand = makeStand({
  'README.md': '# Стенд глубокого отката\n',
  'src/notes.txt': 'строка один\n'
})
const NOTES = 'src/notes.txt'
const atStart = readWork(stand, NOTES)

note('проект:', stand)
const { app, page } = await launchZarya({ work: stand, editPath: NOTES })

try {
  section('[1] Три хода подряд правят один файл')
  const conv = await askAgent(page, editPrompt(NOTES, 'правка первая'))
  const afterFirst = readWork(stand, NOTES)
  await followUp(page, conv, editPrompt(NOTES, 'правка вторая'))
  await followUp(page, conv, editPrompt(NOTES, 'правка третья'))
  const afterThird = readWork(stand, NOTES)
  ok('файл менялся ходами', afterFirst !== atStart || afterThird !== afterFirst, {
    старт: atStart,
    после1: afterFirst,
    после3: afterThird
  })

  const st = await convState(page, conv)
  const turns = (st?.turns ?? []).filter((m) => m.role === 'user' && m.turnId)
  // Точка должна быть у КАЖДОГО хода: откат «на три шага назад» иначе
  // невозможен — выбирать будет не из чего.
  ok('точка отката есть у нескольких ходов', turns.length >= 2, turns.length)
  await shot(page, 'deep-1-turns')

  section('[2] Откат к САМОМУ РАННЕМУ ходу возвращает всё разом')
  // Кнопка у первого хода, а не у последнего: человек говорит «верни как было
  // до всей этой затеи».
  const opened = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const all = [...document.querySelectorAll('.zy-mf-changes-btn')]
      .filter(vis)
      .filter((e) => /Откатить файлы/.test(e.textContent ?? ''))
    all[0]?.click()
    return all.length
  })
  note('кнопок отката в ленте:', opened)
  await page.waitForTimeout(LIVE ? 2500 : 1200)
  const card = await text(page, '.zy-rw')
  ok('карточка первого хода открылась', /вернутся к состоянию/.test(card), card.slice(0, 200))
  await shot(page, 'deep-2-card')

  const goReady = await waitForGo(page, LIVE ? 15000 : 8000)
  if (!ok('кнопка «Откатить» доступна', goReady, (await text(page, '.zy-rw')).slice(0, 300))) {
    throw new Error('карточка не дала кнопку — дальше проверять нечего')
  }
  await page.click('.zy-rw-go')
  await waitDone(page)
  const done = await text(page, '.zy-rw-done')
  note('итог:', done.replace(/\s+/g, ' ').slice(0, 160))
  if (LIVE) {
    // Главное: вернулось состояние ДО первой правки, а не до последней.
    ok('файл вернулся к самому началу', readWork(stand, NOTES) === atStart, {
      ожидали: atStart,
      получили: readWork(stand, NOTES)
    })
  } else {
    skip('файл вернулся к самому началу', 'фейк не трогает диск при откате')
  }
  ok('итог показан числами', /Вернулось/.test(done), done)

  section('[3] Пока идёт ход, откат отказывает — а не портит файлы')
  // Прошлую карточку закрываем: оставленная на экране, она подменяет собой
  // результат следующей проверки (её текст и её кнопка никуда не делись).
  await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    for (const x of [...document.querySelectorAll('.zy-rw-x')].filter(vis)) x.click()
  })
  await page.waitForTimeout(400)
  /*
   * Момент «ход идёт» на быстром движке не поймать секундомером. Зато его
   * можно СОЗДАТЬ: выключаем автопилот, и ход останавливается на вопросе
   * разрешения — состояние, в котором откат обязан отказать по той же причине
   * (человек ещё не решил, а файлы уже поедут).
   */
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, false), conv)
  await page.waitForTimeout(300)
  await page.evaluate((p) => window.__zaryaFollowUp?.(p), editPrompt(NOTES, 'правка во время проверки'))
  await page.waitForTimeout(LIVE ? 6000 : 1500)
  const busyState = await convState(page, conv)
  if (!busyState?.streaming) {
    skip('отказ во время хода', 'ход закончился раньше, чем появился вопрос разрешения')
  } else {
    const r = await openRewind(page, { timeoutMs: 8000 })
    const busyCard = r.card ?? ''
    ok('сказано, что сейчас нельзя', /Идёт ход/.test(busyCard), busyCard.slice(0, 200))
    const goVisible = await page.evaluate(
      () =>
        [...document.querySelectorAll('.zy-rw-go')].filter((el) =>
          el.checkVisibility ? el.checkVisibility() : !!el.offsetParent
        ).length
    )
    ok('кнопки «Откатить» в этом состоянии нет', goVisible === 0, goVisible)
    await shot(page, 'deep-3-busy')
  }
} finally {
  await app.close()
}

cleanup([stand])
finish()
