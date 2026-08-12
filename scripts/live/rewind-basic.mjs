/**
 * Откат: основной путь целиком.
 *
 *   node scripts/live/rewind-basic.mjs             # фейк, быстро, без токенов
 *   ZARYA_LIVE=1 node scripts/live/rewind-basic.mjs   # настоящий Claude Code
 *
 * Один сценарий на два движка — потому что расхождение между ними и есть самое
 * опасное место: фейк отдавал абсолютный путь, настоящий движок относительный,
 * и карточка молчала о потере правки только на живом.
 */
import { join } from 'node:path'
import {
  LIVE,
  askAgent,
  backupContents,
  backupsOf,
  cleanup,
  convState,
  editPrompt,
  fileHistoryCount,
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
  waitDone,
  writeWork
} from '../lib/live-harness.mjs'

const stand = makeStand({
  'README.md': '# Стенд отката\n',
  'src/notes.txt': 'первая строка\nвторая строка\n',
  'src/keep.txt': 'этот файл агент не трогает\n'
})
const NOTES = 'src/notes.txt'
const beforeAgent = readWork(stand, NOTES)
const histBefore = fileHistoryCount()

note('проект:', stand)
const { app, page, userData } = await launchZarya({ work: stand, editPath: NOTES })

try {
  section('[1] Агент правит файл')
  const conv = await askAgent(page, editPrompt(NOTES, 'правка агента'))
  const afterAgent = readWork(stand, NOTES)
  ok('файл изменился на диске', afterAgent !== beforeAgent, { было: beforeAgent, стало: afterAgent })
  await shot(page, 'basic-1-turn')

  section('[2] Точка отката пришла от движка')
  const st = await convState(page, conv)
  // На живом движке это и есть проверка флага --replay-user-messages: без него
  // id хода не приходит, и кнопки нет вовсе.
  ok('сессия сообщила про копии', st?.checkpointing === true, st)
  ok('у хода человека есть точка', (st?.turns ?? []).some((m) => m.role === 'user' && m.turnId), st?.turns)

  section('[3] Человек дописывает в тот же файл')
  writeWork(stand, NOTES, afterAgent + 'моя строка, которую нельзя потерять\n')
  const card = await openRewind(page)
  note('карточка собралась за', card.ms, 'мс')
  ok('карточка открылась', card.opened && /вернутся к состоянию/.test(card.card ?? ''), card.card?.slice(0, 200))
  ok('файл агента в списке', /notes\.txt/.test(card.card ?? ''), card.card?.slice(0, 300))
  ok(
    'сказано, что моя правка пропадёт',
    /правка пропадёт|правили после хода/.test(card.card ?? ''),
    card.card?.slice(0, 400)
  )
  // Файл, которого агент не касался, движок в список не кладёт — и мы не
  // выдумываем его сами.
  ok('чужой файл в список не попал', !/keep\.txt/.test(card.card ?? ''), card.card)
  await shot(page, 'basic-2-card')

  section('[4] Откат вернул файл и сохранил мою правку')
  await page.click('.zy-rw-go')
  await waitDone(page)
  const done = await text(page, '.zy-rw-done')
  note('итог:', done.replace(/\s+/g, ' ').slice(0, 160))
  // Единственная проверка, которую фейк дать не может: он отвечает в
  // протоколе, но файлы на диске не возвращает. Молчать об этом нельзя —
  // зелёный прогон, умолчавший о непроверенном, и есть то самое враньё.
  if (LIVE) {
    ok('файл вернулся к состоянию до правки агента', readWork(stand, NOTES) === beforeAgent, {
      ожидали: beforeAgent,
      получили: readWork(stand, NOTES)
    })
  } else {
    skip('файл вернулся к состоянию до правки агента', 'фейк не трогает диск при откате')
  }
  const dirs = backupsOf(userData)
  ok('копия правки лежит на диске', dirs.length > 0, dirs)
  ok(
    'в копии — именно моя строка',
    backupContents(userData, dirs[0] ?? '').some((c) => /моя строка/.test(c)),
    dirs[0]
  )
  const feed = await text(page, '.zy-mf-notice')
  ok('в ленте осталась отметка числами', /Файлы откачены/.test(feed), feed)
  ok('в отметке нет путей', !feed.includes(join('src', 'notes.txt')), feed)
  await shot(page, 'basic-3-done')
} finally {
  await app.close()
}

/*
 * Настоящий профиль человека — не полигон.
 *
 * На фейке чекпоинты выключены политикой (прогон изолирован, `CLAUDE_CONFIG_DIR`
 * уведён), и движок в `~/.claude` не должен положить НИ ОДНОЙ папки. Раньше это
 * число только печаталось примечанием — то есть прогон смотрел на него и молчал,
 * что бы там ни оказалось. Пункт тест-плана требует проверки, а не отчёта.
 *
 * В живом режиме рост папки ожидаем и законен: копии для того и включены. Там
 * число печатается — по нему видно цену настройки.
 */
const histAfter = fileHistoryCount()
if (LIVE) {
  note('папок в ~/.claude/file-history было', histBefore, '· стало', histAfter)
} else {
  ok('изолированный прогон не насорил в профиле человека', histAfter === histBefore, {
    было: histBefore,
    стало: histAfter
  })
}
cleanup([stand])
finish()
