/**
 * Записки между панелями на настоящем Claude Code.
 *
 *   ZARYA_LIVE=1 node scripts/live/pane-notes.mjs
 *
 * ТОЛЬКО ЖИВОЙ. Всё остальное проверяет `scripts/pane-notes-test.mjs`; здесь —
 * единственный вопрос, на который фейковый драйвер ответить не может: ВИДИТ ЛИ
 * агент наши инструменты и пользуется ли ими по назначению. Инструменты живут
 * внутри процесса Зари, но объявляет их движок, и увидеть их можно только его
 * глазами.
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
  skip('записки между панелями', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд записок\n' })
note('проект:', stand)
const { app, page, userData } = await launchZarya({
  work: stand,
  // Инструменты выключены по умолчанию: это доступ к соседним панелям.
  settings: { ai: { paneMessages: true } }
})

const dump = (page, id) =>
  page.evaluate((cid) => {
    const c = window.__zaryaConvById?.(cid)
    return {
      text: String(c?.text ?? ''),
      kinds: c?.partKinds ?? [],
      notes: c?.noteTexts ?? [],
      error: c?.error ?? null,
      streaming: c?.streaming === true,
      held: c?.noteHeld ?? [],
      title: c?.title ?? ''
    }
  }, id)

try {
  section('[1] Две НАСТОЯЩИЕ панели, каждая со своей сессией')
  /*
   * ДВЕ ОТДЕЛЬНЫЕ ПАНЕЛИ, а не две беседы в одной. Первая версия прогона
   * поднимала обе в активной панели — и получатель наследовал у неё автопилот
   * (он живёт на сессии), из-за чего записка законно придерживалась, а прогон
   * читал это как несработавшую доставку. Панель — это сессия; так и делаем.
   */
  const sidA = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  const a = await page.evaluate(
    ([sid]) =>
      window.__zaryaStartAgentIn?.('claude-code', 'панель альфа: ответь одним словом «готов»', sid),
    [sidA]
  )
  await page.waitForTimeout(1200)
  // Автопилот — только ОТПРАВИТЕЛЮ: вызов инструмента иначе встанет на карточке
  // разрешения, и прогон будет ждать нажатия, которого некому сделать.
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), a)
  await waitIdle(page, a)

  const sidB = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  const b = await page.evaluate(
    ([sid]) =>
      window.__zaryaStartAgentIn?.('claude-code', 'панель бета: ответь одним словом «готов»', sid),
    [sidB]
  )
  await page.waitForTimeout(1200)
  /*
   * У ПОЛУЧАТЕЛЯ АВТОПИЛОТ НЕ ВКЛЮЧАЕМ — и это не упрощение: записка панели на
   * автопилоте придерживается НАРОЧНО, и с ним прогон проверял бы задержку
   * вместо доставки.
   */
  await waitIdle(page, b)
  ok('две панели подняты', !!a && !!b && a !== b, { a, b, sidA, sidB })

  section('[2] Агент видит соседнюю панель СВОИМ инструментом')
  await page.evaluate(
    ([id]) =>
      window.__zaryaSendTo?.(
        id,
        'Позови инструмент mcp__zarya__list_panes и перечисли, что он вернул. Ничего больше не делай.'
      ),
    [a]
  )
  await waitIdle(page, a, 180_000)
  const seen = await dump(page, a)
  note('ответ:', JSON.stringify(seen.text.slice(-220)))
  // Идентификатор соседней беседы — то, чего агент не мог бы выдумать.
  ok('инструмент вернул соседнюю панель', seen.text.includes(b), seen.text.slice(-220))
  await shot(page, 'notes-1-list')

  section('[3] Агент пишет соседу, и записка доходит')
  await page.evaluate(
    ([id, target]) =>
      window.__zaryaSendTo?.(
        id,
        `Позови инструмент mcp__zarya__send_to_pane с pane="${target}" и text="миграция прошла, колонка tenant_id". Больше ничего не делай.`
      ),
    [a, b]
  )
  await waitIdle(page, a, 180_000)
  await page.waitForTimeout(4000)

  // Что сказал САМ отправитель: ответ инструмента приезжает ему, и при отказе
  // только там видно причину.
  const sent = await dump(page, a)
  note('отправитель сказал:', JSON.stringify(sent.text.slice(-400)))

  const got = await dump(page, b)
  note('виды частей у получателя:', JSON.stringify(got.kinds))
  note('записки:', JSON.stringify(got.notes), '· придержаны:', JSON.stringify(got.held))
  ok('записка легла в ленту получателя', got.kinds.includes('pane-note'), got.kinds)
  // Получатель без автопилота — придерживать нечего: записка обязана уйти агенту.
  ok('и НЕ придержана: у получателя вопросы включены', !got.held.some((h) => h !== 'no'), got.held)
  // Текст ищем среди ЗАПИСОК, а не в общем тексте беседы: в него записка не
  // попадает нарочно — она не слова человека и не ответ агента.
  ok(
    'текст доехал целиком',
    got.notes.some((n) => /tenant_id/.test(String(n))),
    got.notes
  )

  // Лента показывает АКТИВНУЮ беседу: чтобы увидеть записку глазами, надо
  // встать в панель получателя — как это сделал бы человек.
  await page.evaluate((id) => window.__zaryaSetActiveConv?.(id), b)
  await page.waitForTimeout(1200)
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-note')].map((n) => n.textContent ?? '').join(' | ')
  )
  ok('на экране названа панель-отправитель', /записка от панели/i.test(shown), shown.slice(0, 160))
  await shot(page, 'notes-2-delivered')

  /*
   * Ход у получателя начинается ОТ ЗАПИСКИ — если бы она осталась просто
   * текстом в ленте, агент бы её не увидел вовсе.
   *
   * Ждём появления ОТВЕТА, а не «беседа не занята»: доставка и запуск хода
   * асинхронны, и `waitIdle` сразу после доставки возвращался мгновенно —
   * прогон читал это как «агент промолчал» через раз.
   */
  const answersIn = (k) => k.filter((x) => x === 'text').length
  const beforeAnswers = answersIn(got.kinds)
  let afterTurn = got
  const untilAnswer = Date.now() + 180_000
  while (Date.now() < untilAnswer) {
    await page.waitForTimeout(2000)
    afterTurn = await dump(page, b)
    if (answersIn(afterTurn.kinds) > beforeAnswers) break
  }
  await waitIdle(page, b, 180_000)
  afterTurn = await dump(page, b)

  section('[4] Закрытой панели инструмент говорит ПРАВДУ')
  /*
   * Реестр в главном процессе — копия, и она отстаёт. Раньше отправитель
   * услышал бы «доставлено» про записку, которую никто не получил: теперь
   * доставка ждёт ответа окна и при пропаже панели говорит об этом прямо.
   */
  await page.evaluate((id) => window.__zaryaDeleteConv?.(id), b)
  await page.waitForTimeout(1500)
  await page.evaluate(
    ([id, target]) =>
      window.__zaryaSendTo?.(
        id,
        `Позови mcp__zarya__send_to_pane с pane="${target}" и text="проверка закрытой панели". Дословно приведи ответ инструмента.`
      ),
    [a, b]
  )
  await waitIdle(page, a, 180_000)
  const gone = await dump(page, a)
  note('ответ про закрытую:', JSON.stringify(gone.text.slice(-260)))
  /*
   * Проверяем, что агент ПОНЯЛ отказ, а не ищем отсутствие слова «Delivered»:
   * он цитирует прошлый успешный вызов, и поиск подстроки ловил цитату вместо
   * утверждения.
   */
  ok(
    'агент понял, что доставки не было',
    /не доставлен|не была доставлена|не удалось доставить|not delivered|no longer open|no other panes/i.test(
      gone.text.slice(-500)
    ),
    gone.text.slice(-260)
  )

  // Ход получателя проверен выше, до закрытия панели.
  const after = afterTurn
  note('ответ получателя:', JSON.stringify(after.text.slice(-200)))
  note(
    'состояние получателя:',
    JSON.stringify({ kinds: after.kinds, error: after.error, streaming: after.streaming })
  )
  /*
   * Проверяем СОДЕРЖАНИЕ ответа, а не число частей: получатель успевает
   * ответить раньше, чем прогон снимает «до», и счёт частей выходил равным при
   * работающей доставке. А вот упоминание сути записки агент мог взять только
   * из неё — в текстовые части записка не попадает вовсе.
   */
  ok(
    'получатель ответил ПО СОДЕРЖАНИЮ записки',
    /tenant_id/i.test(after.text),
    after.text.slice(-200)
  )
} finally {
  await app.close()
  cleanup([stand, userData])
}

finish()
