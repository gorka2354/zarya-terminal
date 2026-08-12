/**
 * Движок замолчал: карточка обязана назвать причину, а не крутиться вечно.
 *
 *   node scripts/live/rewind-hang.mjs
 *
 * Только на фейке — живой Claude Code зависать по заказу не умеет, а ждать
 * настоящего зависания в прогоне бессмысленно. Проверяется НАШ предел ожидания:
 * `rewindFiles` уходит в чужой процесс и может не вернуться никогда (сессия
 * поднялась и молчит, сеть отвалилась, процесс жив, но нем).
 *
 * Без предела карточка вечно показывает «Смотрю, что изменится…»: ни кнопки,
 * ни причины, ни способа выйти — человек смотрит на крутилку и не знает, чего
 * ждёт. Это ровно то молчание, против которого весь инкремент.
 *
 * Предел на время прогона укорочен (`ZARYA_QA_REWIND_TIMEOUT_MS`): проверка,
 * которая идёт две минуты, — это проверка, которую не запускают.
 */
import {
  cleanup,
  finish,
  launchZarya,
  makeStand,
  note,
  ok,
  section,
  shot,
  text
} from '../lib/live-harness.mjs'

if (process.env.ZARYA_LIVE === '1') {
  console.log('ПРОПУЩЕНО: сценарий про зависший движок — только на фейке')
  process.exit(0)
}

const LIMIT_MS = 4000
const stand = makeStand({ 'src/fake.ts': 'const a = 1\nconst b = 2\nkeep me\n' })
note('проект:', stand)

const { app, page } = await launchZarya({
  work: stand,
  env: { ZARYA_FAKE_REWIND: 'hang', ZARYA_QA_REWIND_TIMEOUT_MS: String(LIMIT_MS) }
})

try {
  section('[1] Ход есть, точка отката есть')
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2200)
  const marks = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return (c?.turnMarks ?? []).filter((m) => m.role === 'user' && m.turnId).length
  }, cid)
  ok('точка отката у хода есть', marks > 0, marks)

  section('[2] Карточка открыта, движок молчит')
  const opened = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const b = [...document.querySelectorAll('.zy-mf-changes-btn')]
      .filter(vis)
      .filter((e) => /Откатить файлы/.test(e.textContent ?? ''))
      .pop()
    b?.click()
    return !!b
  })
  ok('кнопка отката нашлась', opened)
  await page.waitForTimeout(800)
  const waiting = await text(page, '.zy-rw')
  ok('пока ждём — так и сказано', /Смотрю, что изменится/.test(waiting), waiting.slice(0, 160))
  await shot(page, 'hang-1-waiting')

  section('[3] Предел вышел — причина названа словами')
  // Ждём предел плюс запас на дорогу до окна.
  await page.waitForTimeout(LIMIT_MS + 3000)
  const after = await text(page, '.zy-rw')
  note('карточка:', after.replace(/\s+/g, ' ').slice(0, 200))
  ok('крутилка сменилась ответом', !/Смотрю, что изменится/.test(after), after.slice(0, 200))
  ok('сказано, что движок не ответил', /не ответил вовремя/.test(after), after.slice(0, 200))
  // Главное в этом тексте: мы НЕ обещаем, что на диске всё по-прежнему. Движок
  // мог успеть переписать часть файлов и замолчать уже после этого.
  ok('не обещано, что диск не тронут', /неизвестно/.test(after), after.slice(0, 250))
  ok('назван ручной путь', /что изменилось/.test(after), after.slice(0, 250))
  // Кнопки «Откатить» быть не должно: жать её означало бы начать второй заход
  // поверх первого, который, возможно, ещё идёт.
  const go = await page.evaluate(
    () =>
      [...document.querySelectorAll('.zy-rw-go')].filter((el) =>
        el.checkVisibility ? el.checkVisibility() : !!el.offsetParent
      ).length
  )
  ok('кнопки «Откатить» нет', go === 0, go)
  await shot(page, 'hang-2-refused')
} finally {
  await app.close()
}

cleanup([stand])
finish()
