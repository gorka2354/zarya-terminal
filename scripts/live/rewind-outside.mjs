/**
 * Файл ВНЕ папки проекта — радиус отката шире, чем кажется.
 *
 *   node scripts/live/rewind-outside.mjs
 *   ZARYA_LIVE=1 node scripts/live/rewind-outside.mjs
 *
 * В разведке настоящий Claude Code при работе в одной папке записал файл в
 * ЧУЖОЙ проект на рабочем столе, а откат потом удалил его там же. Радиус
 * отката — это все пути, которых касался агент, а не папка панели. Человек
 * должен узнать об этом ДО нажатия, поэтому в карточке есть отдельный значок.
 *
 * Здесь это воспроизводится намеренно: агент правит файл в соседней папке, и
 * карточка обязана его назвать и пометить.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIVE,
  askAgent,
  cleanup,
  editPrompt,
  finish,
  launchZarya,
  makeStand,
  note,
  ok,
  openRewind,
  section,
  shot,
  skip,
  text,
  waitForGo
} from '../lib/live-harness.mjs'

const stand = makeStand({
  'README.md': '# Проект панели\n',
  'src/own.txt': 'файл этого проекта\n'
})
// Соседняя папка — «чужой проект» рядом. Своего git у неё нет намеренно: она и
// не должна попадать ни в какие наши списки, кроме списка отката.
const neighbour = mkdtempSync(join(tmpdir(), 'zarya-neighbour-'))
const OUTSIDE = join(neighbour, 'stranger.txt')
writeFileSync(OUTSIDE, 'строка чужого проекта\n')
const outsideBefore = readFileSync(OUTSIDE, 'utf8')

note('проект панели:', stand)
note('чужая папка:', neighbour)

const { app, page } = await launchZarya({ work: stand, editPath: OUTSIDE })

try {
  section('[1] Агент правит файл за пределами своей папки')
  await askAgent(page, editPrompt(OUTSIDE, 'правка в чужой папке'))
  const after = readFileSync(OUTSIDE, 'utf8')
  ok('файл в чужой папке изменён', after !== outsideBefore, { было: outsideBefore, стало: after })
  await shot(page, 'outside-1-turn')

  section('[2] Карточка называет его и помечает как внешний')
  const card = await openRewind(page, { timeoutMs: LIVE ? 30000 : 10000 })
  ok('карточка открылась', /Файлов:/.test(card.card ?? ''), card.card?.slice(0, 240))
  ok('чужой файл назван', /stranger\.txt/.test(card.card ?? ''), card.card?.slice(0, 300))
  // Главное: человек видит, что откат тронет файл ЗА пределами папки панели.
  // Без этого значка он согласится, думая, что речь только про его проект.
  ok('помечен как «вне папки агента»', /вне папки агента/.test(card.card ?? ''), card.card?.slice(0, 400))
  await shot(page, 'outside-2-card')

  section('[3] Откат честно доходит до чужой папки')
  const goReady = await waitForGo(page, LIVE ? 20000 : 8000)
  if (ok('кнопка «Откатить» доступна', goReady, (await text(page, '.zy-rw')).slice(0, 240))) {
    await page.click('.zy-rw-go')
    await page.waitForTimeout(LIVE ? 4500 : 2000)
    const done = await text(page, '.zy-rw-done')
    note('итог:', done.replace(/\s+/g, ' ').slice(0, 160))
    if (LIVE) {
      // Радиус подтверждается делом: файл в ЧУЖОЙ папке вернулся к прежнему
      // виду. Это не ошибка отката — это его настоящая область действия, и
      // именно поэтому карточка обязана была о ней сказать.
      ok('файл в чужой папке вернулся к прежнему виду', readFileSync(OUTSIDE, 'utf8') === outsideBefore, {
        ожидали: outsideBefore,
        получили: readFileSync(OUTSIDE, 'utf8')
      })
    } else {
      skip('файл в чужой папке вернулся', 'фейк не трогает диск при откате')
    }
    ok('итог показан числами', /Вернулось/.test(done), done)
    await shot(page, 'outside-3-done')
  }
} finally {
  await app.close()
}

cleanup([stand, neighbour])
finish()
