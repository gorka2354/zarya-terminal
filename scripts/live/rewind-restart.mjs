/**
 * Откат в беседе, поднятой с диска после перезапуска Зари.
 *
 *   node scripts/live/rewind-restart.mjs
 *   ZARYA_LIVE=1 node scripts/live/rewind-restart.mjs
 *
 * Самый частый способ вернуться к вчерашней работе — открыть Зарю утром. Живого
 * процесса движка в этот момент нет, и откат обязан поднять сессию сам (аренда):
 * он не стоит ни одного обращения к модели, поэтому требовать «сначала напишите
 * что-нибудь агенту» ради возврата файлов было бы выдуманным ограничением.
 *
 * Здесь же проверяется, что карта наблюдений пережила перезапуск: без неё
 * карточка не смогла бы сказать «правку потеряете» и честно говорила бы «не
 * ручаемся» — то есть теряла бы главное ровно в самом нужном случае.
 */
import { join } from 'node:path'
import {
  LIVE,
  askAgent,
  backupsOf,
  cleanup,
  convState,
  editPrompt,
  finish,
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
  waitForGo,
  writeWork
} from '../lib/live-harness.mjs'

const stand = makeStand({
  'README.md': '# Стенд перезапуска\n',
  'src/notes.txt': 'строка один\nстрока два\n'
})
const NOTES = 'src/notes.txt'
const atStart = readWork(stand, NOTES)

note('проект:', stand)

/* ── Первый запуск: агент правит файл, потом Зарю закрывают ─────────────── */
let convId = null
let userData = null
{
  const run = await launchZarya({ work: stand, editPath: NOTES })
  userData = run.userData
  try {
    section('[1] Агент правит файл, приложение закрывается')
    convId = await askAgent(run.page, editPrompt(NOTES, 'правка агента до перезапуска'))
    const afterAgent = readWork(stand, NOTES)
    ok('файл изменён агентом', afterAgent !== atStart, { было: atStart, стало: afterAgent })
    const st = await convState(run.page, convId)
    ok('точка отката получена', (st?.turns ?? []).some((m) => m.role === 'user' && m.turnId), st?.turns)
    // Человек дописывает своё — и уходит спать.
    writeWork(stand, NOTES, afterAgent + 'вечерняя строка человека\n')
    await shot(run.page, 'restart-1-before')
  } finally {
    await run.app.close()
  }
}

/* ── Второй запуск: живого процесса движка нет ──────────────────────────── */
{
  /*
   * ТОТ ЖЕ профиль — и НИКАКОГО нового терминала: панель со вчерашней беседой
   * восстанавливается сама. Создать новую значило бы смотреть в пустую ленту и
   * решить, что кнопки нет (на этом прогон и попался).
   */
  const run = await launchZarya({ userData, editPath: NOTES })
  try {
    section('[2] Беседа поднялась с диска вместе с точкой отката')
    await run.page.waitForTimeout(LIVE ? 2500 : 1500)
    const st = await convState(run.page, convId)
    ok('беседа на месте', !!st, st)
    ok(
      'точка отката пережила перезапуск',
      (st?.turns ?? []).some((m) => m.role === 'user' && m.turnId),
      st?.turns
    )
    // Живой сессии нет: ход после перезапуска не отправлялся.
    ok('живого хода в беседе нет', st?.streaming === false, st)

    section('[3] Откат работает без предварительного хода — сессию поднимает сам')
    // Диагностика: что вообще показывает лента после перезапуска.
    const seen = await run.page.evaluate(() => {
      const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
      return {
        кнопок: [...document.querySelectorAll('.zy-mf-changes-btn')].filter(vis).length,
        ходов: [...document.querySelectorAll('.zy-mf-user')].filter(vis).length,
        подписи: [...document.querySelectorAll('.zy-mf-changes-btn')]
          .filter(vis)
          .map((e) => e.textContent ?? '')
      }
    })
    note('в ленте:', JSON.stringify(seen))
    // Ключ беседы должен совпасть с ключом в agent-files.json — иначе карта
    // поднимется «не для той» беседы и карточка скажет «не ручаемся».
    note('id беседы:', convId)
    try {
      const raw = JSON.parse(
        (await import('node:fs')).readFileSync(join(userData, 'agent-files.json'), 'utf8')
      )
      note('ключи в карте на диске:', Object.keys(raw).join(', ') || '(пусто)')
      note('путей у нашей беседы:', Object.keys(raw[convId]?.files ?? {}).length)
    } catch (e) {
      note('карта на диске не прочиталась:', String(e).slice(0, 80))
    }
    const card = await openRewind(run.page, { timeoutMs: LIVE ? 30000 : 10000 })
    note('карточка собралась за', card.ms, 'мс')
    ok('карточка открылась', /вернутся к состоянию|Файлов:/.test(card.card ?? ''), card.card?.slice(0, 240))
    // Карта наблюдений тоже с диска — иначе тут было бы «не ручаемся».
    ok(
      'карта пережила перезапуск: сказано про мою правку',
      /правка пропадёт|правили после хода/.test(card.card ?? ''),
      card.card?.slice(0, 400)
    )
    await shot(run.page, 'restart-2-card')

    const goReady = await waitForGo(run.page, LIVE ? 20000 : 8000)
    if (ok('кнопка «Откатить» доступна', goReady, (await text(run.page, '.zy-rw')).slice(0, 300))) {
      await run.page.click('.zy-rw-go')
      await run.page.waitForTimeout(LIVE ? 5000 : 2000)
      const done = await text(run.page, '.zy-rw-done')
      note('итог:', done.replace(/\s+/g, ' ').slice(0, 160))
      if (LIVE) {
        ok('файл вернулся к состоянию до правки агента', readWork(stand, NOTES) === atStart, {
          ожидали: atStart,
          получили: readWork(stand, NOTES)
        })
      } else {
        skip('файл вернулся к состоянию до правки агента', 'фейк не трогает диск при откате')
      }
      ok('вечерняя правка сохранена копией', backupsOf(userData).length > 0, backupsOf(userData))
      await shot(run.page, 'restart-3-done')
    }
  } finally {
    await run.app.close()
  }
}

cleanup([stand])
finish()
