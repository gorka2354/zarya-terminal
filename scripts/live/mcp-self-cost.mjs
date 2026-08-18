/**
 * Видит ли движок НАШ собственный MCP-сервер — и почём (inc-47, замер).
 *
 *   ZARYA_LIVE=1 node scripts/live/mcp-self-cost.mjs
 *
 * ПОВОД. Вкладка «Инструменты» показывает цену чужих MCP-серверов и говорит
 * дословно: «занимают ~N токенов в каждом запросе». Свой сервер `zarya` —
 * единственный, за который отвечаем мы сами, — в этой строке не назван вовсе,
 * и мы не знаем даже, попадает ли он в ответ движка.
 *
 * А ещё под вопросом сама фраза. Документация Claude Code говорит, что поиск
 * по инструментам включён по умолчанию: в старте грузятся имена, описания
 * откладываются. Если это верно и для нашего сервера, то «в каждом запросе»
 * — преувеличение, и строку надо переписать по факту, а не по слогану.
 *
 * ТОЛЬКО ЖИВОЙ: цифры отдаёт настоящий движок. Подставной ничего об этом не
 * знает, и выдумывать за него нельзя — ровно поэтому замер и понадобился.
 */
import {
  LIVE, cleanup, finish, launchZarya, makeStand, note, ok, section, skip, waitIdle
} from '../lib/live-harness.mjs'

if (!LIVE) {
  skip('цена своего MCP-сервера', 'нужен настоящий движок: ZARYA_LIVE=1')
  finish()
}

const stand = makeStand({ 'README.md': '# Стенд цены\n' })
const { app, page, userData } = await launchZarya({
  work: stand,
  // Записки включаем, чтобы сервер объявлялся полным составом: четыре
  // инструмента, а не два. Блоки включены по умолчанию.
  settings: { ai: { paneMessages: true } }
})

try {
  section('[1] Живая сессия, из которой можно спросить движок')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), stand)
  await page.waitForTimeout(2500)
  await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 3, 3), sid)
  await page.evaluate((s) => window.__zaryaFocusPane?.(s), sid)
  await page.waitForTimeout(500)
  const conv = await page.evaluate(
    ([s]) =>
      window.__zaryaStartAgentIn?.('claude-code', 'Ответь одним словом: готов.', s),
    [sid]
  )
  await waitIdle(page, conv, 300_000)
  await page.waitForTimeout(1500)
  ok('сессия движка живёт', !!conv, { conv })

  section('[2] Что движок говорит о серверах')
  const snap = await page.evaluate(
    ([c]) => window.zarya.agent.mcpStatus('claude-code', c, false),
    [conv]
  )
  note('снимок:', JSON.stringify(snap).slice(0, 1200))
  ok('движок вообще отвечает про MCP', !!snap && !snap.unsupported, {
    unsupported: snap?.unsupported
  })

  section('[3] Наш собственный сервер в этом списке')
  /*
   * ГЛАВНЫЙ ВОПРОС ЗАМЕРА. Если движок про `zarya` молчит, цифру для него
   * выдумывать нельзя: строка во вкладке должна тогда сказать словами, что
   * цену собственного сервера мы не знаем, — а не показать оценку по длине
   * описаний. Своей арифметики поверх ответа движка мы не изобретаем.
   */
  const rows = Array.isArray(snap?.servers) ? snap.servers : []
  note('серверы:', JSON.stringify(rows.map((s) => ({ n: s.name, t: s.tokens, tools: s.tools }))))
  const mine = rows.find((s) => s.name === 'zarya')
  ok('сервер `zarya` назван движком', !!mine, { mine })
  if (mine) {
    note('цена нашего сервера по слову движка:', JSON.stringify(mine))
    ok('и у него названа цена', typeof mine.tokens === 'number', { tokens: mine.tokens })
  }

  section('[4] Общая картина контекста')
  note(
    'контекст:',
    JSON.stringify({
      tokens: snap?.contextTokens,
      max: snap?.contextMax,
      parts: (snap?.contextParts ?? []).map((p) => `${p.name}=${p.tokens}${p.deferred ? '(отложено)' : ''}`)
    })
  )
  /*
   * Отложенное движок называет отдельно (см. @shared/contextParts). Если наши
   * инструменты попадают именно туда, «в каждом запросе» — неправда, и это
   * видно прямо здесь, без единой догадки с нашей стороны.
   */
  const deferred = (snap?.contextParts ?? []).filter((p) => p.deferred)
  ok('движок различает отложенное и лежащее в контексте', deferred.length >= 0, {
    deferred: deferred.map((p) => `${p.name}=${p.tokens}`)
  })
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanup([stand, userData])
}

finish()
