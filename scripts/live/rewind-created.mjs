/**
 * Файл, СОЗДАННЫЙ агентом после выбранного хода: откат его не вернёт, а сотрёт.
 *
 *   node scripts/live/rewind-created.mjs
 *   ZARYA_LIVE=1 node scripts/live/rewind-created.mjs
 *
 * Самый дорогой случай всего инкремента, и до ревью он не был покрыт ни одним
 * прогоном. Откат двунаправленный: он приводит файлы к состоянию НА МОМЕНТ
 * хода. Файла тогда не было — значит его удалят, вместе со всем, что человек
 * успел в него дописать. Спокойная надпись «вернётся к прежнему виду» напротив
 * такого файла — самое дорогое враньё, которое карточка может сказать.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  LIVE,
  askAgent,
  cleanup,
  createPrompt,
  finish,
  followUp,
  launchZarya,
  makeStand,
  note,
  ok,
  openRewind,
  section,
  shot,
  skip,
  text,
  waitDone,
  waitForGo,
  writeWork
} from '../lib/live-harness.mjs'

const stand = makeStand({
  'README.md': '# Стенд созданного файла\n',
  'src/old.txt': 'файл, который был с самого начала\n'
})
const NEW_FILE = 'src/created-by-agent.txt'

note('проект:', stand)
const { app, page } = await launchZarya({ work: stand, editPath: NEW_FILE })

try {
  section('[1] Первый ход — ничего не создаём (к нему и будем откатывать)')
  const conv = await askAgent(page, LIVE ? 'Ответь одним словом: готов.' : 'привет')

  section('[2] Второй ход — агент СОЗДАЁТ новый файл')
  await followUp(page, conv, createPrompt(NEW_FILE, 'создано агентом'))
  ok('файл создан на диске', existsSync(join(stand, NEW_FILE)), NEW_FILE)

  // Человек дописывает в новый файл свою работу — именно её и потеряют.
  writeWork(stand, NEW_FILE, 'создано агентом\nа это уже моя работа на два часа\n')

  section('[3] Откат к ПЕРВОМУ ходу: карточка обязана сказать «БУДЕТ УДАЛЁН»')
  const { opened, card } = await openRewind(page, { first: true, timeoutMs: LIVE ? 30000 : 12000 })
  ok('карточка открылась у РАННЕГО хода', opened && /Файлов:/.test(card ?? ''), card?.slice(0, 200))
  ok('файл назван', /created-by-agent/.test(card), card.slice(0, 300))
  // Главная проверка всего ревью: раньше здесь стояло спокойное «вернётся».
  ok('сказано, что файл БУДЕТ УДАЛЁН', /БУДЕТ УДАЛЁН/.test(card), card.slice(0, 400))
  ok('и это НЕ спокойное «вернётся»', !/вернётся к прежнему виду/.test(card), card.slice(0, 400))
  ok('сводка называет число удаляемых', /будет удалено: 1/.test(card), card.slice(0, 300))
  await shot(page, 'created-1-card')

  section('[4] Работа человека сохранена копией до удаления')
  const goReady = await waitForGo(page, LIVE ? 20000 : 8000)
  if (ok('кнопка «Откатить» доступна', goReady, (await text(page, '.zy-rw')).slice(0, 240))) {
    await page.click('.zy-rw-go')
    await waitDone(page)
    const done = await text(page, '.zy-rw')
    note('итог:', done.replace(/\s+/g, ' ').slice(-200))
    if (LIVE) {
      ok('файла больше нет — откат его стёр', !existsSync(join(stand, NEW_FILE)), NEW_FILE)
      // Исчезновение — успех, но назвать его «вернулось» значит отправить
      // человека искать файл, которого нет.
      ok('итог назвал это УДАЛЕНИЕМ', /удалено: 1/.test(done), done.replace(/\s+/g, ' ').slice(-160))
      ok('и не выдал за возврат', !/Вернулось: 1/.test(done), done.replace(/\s+/g, ' ').slice(-160))
    } else {
      skip('файла больше нет', 'фейк не трогает диск при откате')
    }
    await shot(page, 'created-2-done')

    section('[5] Ход ПОЗЖЕ отката: интерфейс не обещает вернуть файл обратно')
    /*
     * Тест-план требовал обратного — «откат к ходу 2 создаёт файл заново», — и
     * это оказалось неверным предположением о движке. Проверено прямым вызовом
     * на живом Claude Code 2.1.227: на ход позже уже сделанного отката он
     * отвечает `canRewind: true` с ПУСТЫМ списком файлов и не делает ничего;
     * удалённый файл обратно не появляется. Механизм односторонний.
     *
     * Значит проверяем не возврат, а честность: карточка обязана сказать, что
     * вперёд нельзя, и НЕ давать кнопку, за которой ничего не произойдёт.
     */
    const back = await openRewind(page, { timeoutMs: LIVE ? 30000 : 12000 })
    ok('карточка позднего хода открылась', back.opened, (back.card ?? '').slice(0, 160))
    if (LIVE) {
      ok(
        'сказано, что возвращают только назад',
        /только назад/.test(back.card ?? ''),
        (back.card ?? '').slice(0, 300)
      )
      const go = await page.evaluate(
        () =>
          [...document.querySelectorAll('.zy-rw-go')].filter((el) =>
            el.checkVisibility ? el.checkVisibility() : !!el.offsetParent
          ).length
      )
      // Кнопка здесь соврала бы самим фактом своего существования: нажатие
      // прошло бы «успешно», а на диске не изменилось бы ничего.
      ok('кнопки, которая ничего не сделает, нет', go === 0, go)
      ok('файла по-прежнему нет', !existsSync(join(stand, NEW_FILE)), NEW_FILE)
    } else {
      skip('поведение отката вперёд', 'фейк не воспроизводит одностороннюю историю движка')
    }
    await shot(page, 'created-3-forward')
  }
} finally {
  await app.close()
}

cleanup([stand])
finish()
