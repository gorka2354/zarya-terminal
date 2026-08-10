/**
 * Четыре сигнала inc-27 на НАСТОЯЩЕМ Claude Code.
 *
 * Фальшивый драйвер этого доказать не может: он отдаёт уже готовые события, а
 * весь написанный код — это РАЗБОР того, что присылает SDK. Проверка на подделке
 * проверила бы только показ.
 *
 * Что смотрим:
 *   1) вызов печатается на глазах (`input_json_delta` → строка набора);
 *   2) пульс инструмента (`tool_progress`);
 *   3) факты о результате (`tool_use_result`);
 *   4) картинки из инструмента (`image` в результате).
 *
 * ВАЖНО про честность прогона. Пункты 2 и 4 зависят от того, ШЛЁТ ли их движок
 * для этих инструментов, — в типах SDK такого обещания нет. Поэтому их
 * отсутствие прогон не считает провалом, а печатает отдельной строкой: разница
 * между «мы не показали» и «нам не прислали» — это разница между нашей ошибкой
 * и чужим молчанием, и заваливать прогон на второй значило бы врать о первом.
 *
 * Требует живого входа в Claude Code и тратит токены подписки.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-sig-live-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-sig-work-'))
let pass = 0,
  fail = 0
const notes = []
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}
/** Наблюдение, а не приговор: движок вправе этого не присылать. */
const note = (text) => {
  notes.push(text)
  console.log('  ·', text)
}

/*
 * Файл в точно отмеренном окне: больше одного чтения, но меньше потолка Read.
 *
 * Обе границы найдены вживую, а не выдуманы. 4000 КОРОТКИХ строк движок читает
 * ЦЕЛИКОМ (`numLines: 4000, totalLines: 4000`) — факта о неполноте честно нет, и
 * прогон объявлял провалом работающий код. Файл на 1.1 МБ движок не читает
 * ВОВСЕ: «File content (1.1MB) exceeds maximum allowed size (256KB)», и
 * разобранного итога вместо объекта приходит строка ошибки.
 *
 * Между этими двумя ошибками и лежит настоящая проверка: около 240 КБ.
 */
const big = join(work, 'big.txt')
writeFileSync(
  big,
  Array.from(
    { length: 4000 },
    (_, i) => `строка ${i + 1} — какой-то текст подлиннее чтобы файл был весомым`
  ).join('\n')
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const state = (page) =>
  page.evaluate(() => {
    const c = window.__zaryaDumpConv?.()
    if (!c) return null
    const tools = []
    const facts = []
    for (const m of c.messages) {
      for (const p of m.content) {
        if (p.type === 'tool_use') tools.push(p.name)
        if (p.type === 'tool_result') {
          for (const f of p.facts ?? []) facts.push(f)
        }
      }
    }
    return {
      streaming: c.streaming,
      error: c.error,
      gates: (c.pendingTools || []).filter((t) => !t.settled).map((t) => t.name),
      tools,
      facts,
      typedTool: c.typedTool,
      pulses: Object.values(c.toolPulses ?? {}),
      images: Object.values(c.toolImages ?? {}).flat()
    }
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)

  const sid = await page.evaluate((cwd) => window.__zaryaNewTerminal?.(cwd), work)
  await page.waitForTimeout(2500)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'claude-code'), sid)
  // Автопилот: прогон смотрит на СИГНАЛЫ хода, а не на гейты, и вопрос посреди
  // хода остановил бы его на первом же инструменте.
  await page.evaluate((s) => window.__zaryaSetBypassFor?.(s, true), sid)
  await page.waitForTimeout(600)

  await page.evaluate(
    (f) =>
      window.__zaryaStartAgent?.(
        'claude-code',
        'Сделай ровно это, без объяснений и без лишних инструментов: ' +
          '1) инструментом Bash выполни `echo раз && echo два && echo три && echo четыре && echo пять && sleep 10 && echo готово`; ' +
          // Чтение КУСКА файла — самый обычный случай работы агента, и ровно
          // тот, где карточка молчала о неполноте. Полный файл не годится: он
          // либо читается целиком (факта нет и быть не должно), либо не читается
          // вовсе — движок отказывает всему, что больше 256 КБ.
          '2) инструментом Read прочитай файл ' +
          f +
          ' с параметрами offset 1 и limit 200; ' +
          '3) ответь одним словом «всё».'
      ),
    big
  )

  /*
   * Строку набора надо ловить ЧАСТО. Она живёт от первого куска аргументов до
   * целого сообщения — на короткой команде это доли секунды, и опрос раз в
   * 400 мс её проносил мимо: прогон объявлял провалом код, который работает.
   * Отсюда и длинная команда в запросе выше.
   */
  let typed = null
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(120)
    const s = await state(page)
    if (s?.typedTool) {
      typed = s.typedTool
      // Ждём, пока аргумент дорастёт: первый кадр часто ещё пуст.
      if (typed.preview) break
    }
    if (s && !s.streaming && s.tools.length) break
  }

  console.log('\n[1] Вызов печатается на глазах')
  ok('движок прислал куски аргументов, и строка набора появилась', !!typed, typed)
  if (typed) {
    ok('инструмент в ней назван', !!typed.name, typed)
    if (!typed.preview) note('аргумент в строке набора был пуст — поймали самый первый кадр')
  }
  if (shots && typed) await page.screenshot({ path: join(shots, 'live-tool-typing.png') })

  console.log('\n[2] Пульс инструмента — пока идёт долгая команда')
  let pulses = []
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(700)
    const s = await state(page)
    if (s?.pulses?.length) pulses = s.pulses
    if (pulses.length >= 2) break
    if (s && !s.streaming) break
  }
  if (pulses.length) {
    ok('движок шлёт сердцебиение живого вызова', true)
    ok('и называет своё время', pulses.some((p) => typeof p.elapsedSec === 'number'), pulses)
    if (shots) await page.screenshot({ path: join(shots, 'live-tool-pulse.png') })
  } else {
    /*
     * НЕ ПРОВАЛ, а факт о движке. Проверено тремя прямыми зондами к SDK (короткий
     * Bash, `sleep 75`, субагент Task): CLI 2.1.226 не присылает `tool_progress`
     * ни разу — тип в `sdk.d.ts` объявлен, но в headless-режиме не эмитится.
     * Разбор в драйвере от этого не становится неверным, а карточка при таком
     * молчании ничего не утверждает — ровно как задумано.
     */
    note(
      'tool_progress не пришёл: CLI 2.1.226 его не шлёт вовсе (проверено зондами к SDK). Разбор ждёт своего часа, карточка при этом молчит — и правильно делает'
    )
  }

  console.log('\n[3] Факты о результате')
  let seen = null
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1500)
    seen = await state(page)
    if (seen && !seen.streaming && seen.tools.length >= 2) break
  }
  console.log('  инструменты хода:', JSON.stringify(seen?.tools))
  console.log('  факты:', JSON.stringify(seen?.facts))
  ok('ход дошёл до Read', (seen?.tools ?? []).some((n) => /^read$/i.test(n)), seen?.tools)
  const part = (seen?.facts ?? []).find((f) => f.key === 'fact.read.part')
  ok('движок сказал, сколько строк из скольких прочитано', !!part, seen?.facts)
  if (part) {
    ok('и это предупреждение о неполноте', part.level === 'warn', part)
    ok('цифры настоящие, а не выдуманные', part.vars?.total === 4000, part.vars)
  }
  ok('ошибок в ходе нет', !seen?.error, seen?.error)
  if (shots) await page.screenshot({ path: join(shots, 'live-tool-facts.png') })

  console.log('\n[4] Картинки из инструмента')
  if (seen?.images?.length) {
    ok('картинка дошла из настоящего результата', true, seen.images)
  } else {
    note('картинок в этом ходу не было — ни один вызванный инструмент их не возвращает; проверено фейком (tool-image 14/14)')
  }

  if (notes.length) {
    console.log('\nНаблюдения (не провалы):')
    for (const n of notes) console.log('  ·', n)
  }
  console.log(`\n[tool-signals-live] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // временная папка не удалилась — не повод ронять прогон
  }
}
process.exit(fail ? 1 : 0)
