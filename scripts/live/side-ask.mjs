/**
 * Боковой вопрос на настоящем Claude Code (inc-43).
 *
 *   ZARYA_LIVE=1 node scripts/live/side-ask.mjs
 *
 * ТОЛЬКО ЖИВОЙ, и по единственной причине: доказать обещание можно лишь чужой
 * памятью. Спросили сбоку — и следующий ход НЕ ДОЛЖЕН об этом помнить. Никакой
 * фейковый драйвер этого не покажет: у него нет ни форка сессии, ни памяти.
 *
 * Приём тот же, что в живом прогоне отмены (`esc-rewind-live.mjs`): даём агенту
 * слово-маркер и потом спрашиваем, помнит ли он его. Помнит — обещание не
 * сбылось, и никакая зелёная плашка этого не исправит.
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
  skip('боковой вопрос', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд бокового вопроса\n' })
note('проект:', stand)
const { app, page, userData } = await launchZarya({ work: stand })

const dump = (page, id) =>
  page.evaluate((cid) => {
    const c = window.__zaryaConvById?.(cid)
    return {
      text: String(c?.text ?? ''),
      answer: String(c?.lastAnswer ?? ''),
      kinds: c?.partKinds ?? [],
      sideMarks: c?.sideMarks ?? [],
      error: c?.error ?? null
    }
  }, id)

try {
  section('[1] Обычный ход — агенту есть что помнить')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  const a = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.(
        'claude-code',
        'Запомни слово КЕДР. Ответь одним словом «запомнил».',
        s
      ),
    [sid]
  )
  await waitIdle(page, a, 240_000)
  const first = await dump(page, a)
  note('ответ:', JSON.stringify(first.text.slice(-120)))
  ok('первый ход прошёл', !first.error, first.error)

  section('[2] Боковой вопрос — задан и отвечен')
  /*
   * Слово-маркер во ВТОРОМ вопросе своё: именно его агент не должен помнить
   * дальше. Первое (КЕДР) — контроль: оно ехало обычным ходом и обязано
   * остаться, иначе прогон доказывал бы не то (что сломалась вся сессия).
   */
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendSide?.(id, 'Запомни слово ЛИПА. Ответь одним словом «запомнил».'),
    [a]
  )
  await waitIdle(page, a, 240_000)
  await page.waitForTimeout(1500)
  const side = await dump(page, a)
  note('виды частей:', JSON.stringify(side.kinds))
  note('пометки:', JSON.stringify(side.sideMarks))
  ok('пара помечена как боковая', side.kinds.includes('side-mark'), side.kinds)
  ok('и пометка говорит, что обещание сбылось', side.sideMarks[0] === true, side.sideMarks)
  const mark = await page.evaluate(
    () => document.querySelector('.zy-mf-side')?.textContent ?? ''
  )
  note('на экране:', JSON.stringify(mark))
  ok('в ленте видна граница', /сбоку/i.test(mark), mark)
  await shot(page, 'side-1-asked')

  section('[2a] ВТОРОЙ боковой подряд — первый тоже не должен просочиться')
  /*
   * Поймано ревью: на втором клике движок отдавал точку ПОСЛЕ первой боковой
   * пары, и та тихо оставалась в контексте под пометкой «дальше не поедет».
   * Теперь уже стоящая точка важнее свежей — проверяем это чужой памятью.
   */
  await page.evaluate(
    ([id]) => window.__zaryaSendSide?.(id, 'Запомни слово ОЛЬХА. Ответь одним словом «запомнил».'),
    [a]
  )
  await waitIdle(page, a, 240_000)
  await page.waitForTimeout(1200)
  const side2 = await dump(page, a)
  ok('вторая боковая пара тоже помечена', side2.sideMarks.length === 2, side2.sideMarks)
  ok('и обе пометки обещают одно и то же', side2.sideMarks.every((x) => x === true), side2.sideMarks)

  section('[3] ГЛАВНОЕ: следующий ход бокового вопроса НЕ ПОМНИТ')
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Какие слова я просил тебя запомнить в этом разговоре? Перечисли их, ничего не выдумывая.'
      ),
    [a]
  )
  await waitIdle(page, a, 240_000)
  const after = await dump(page, a)
  note('ПОСЛЕДНИЙ ответ агента:', JSON.stringify(after.answer.slice(-240)))
  /*
   * Ищем в ПОСЛЕДНЕМ ОТВЕТЕ, а не во всей ленте: там же лежит реплика человека
   * «запомни слово ЛИПА», которая никуда не делась и деться не должна.
   * Первая версия прогона падала именно на этом — при работающем коде.
   */
  ok('агент помнит слово из ОБЫЧНОГО хода', /кедр/i.test(after.answer), after.answer.slice(-240))
  ok('и НЕ помнит слово из ПЕРВОГО бокового', !/липа/i.test(after.answer), after.answer.slice(-240))
  // Вторая половина находки ревью: первый боковой не должен просочиться из-за
  // второго. Оба слова проверяем в одном ответе — так видно и подмену точки.
  ok('и НЕ помнит слово из ВТОРОГО бокового', !/ольха/i.test(after.answer), after.answer.slice(-240))
  await shot(page, 'side-2-forgot')

  section('[4] Лента ничего не потеряла')
  ok(
    'боковая пара осталась видна человеку',
    after.kinds.includes('side-mark') && /ЛИПА/i.test(JSON.stringify(after.kinds) + after.text) === false
      ? true
      : after.kinds.includes('side-mark'),
    after.kinds
  )
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanup([stand, userData])
}

finish()
