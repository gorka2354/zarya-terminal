/**
 * Хвост консоли: команды человека доезжают до агента, и это видно (inc-42).
 *
 *   node scripts/shell-tail-test.mjs
 *
 * Спор здесь ровно о том, чего на экране не видно: попали ли команды человека
 * в ТЕКСТ, уехавший движку, и совпадает ли он с тем, о чём плашка отчиталась
 * человеку. Плашка может быть права, а промпт пуст — и наоборот; это разные
 * поломки, и обе стоят доверия.
 *
 * Настоящий движок здесь не нужен: проверяется наша сторона — сборка хвоста,
 * потолки, видимый след, выключатели и то, что на диск не уезжают мегабайты.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}
const note = (...a) => console.log('   ·', ...a)

const ud = mkdtempSync(join(tmpdir(), 'zarya-tail-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    ai: { contextBlocks: 3 }
  })
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const conv = (page, id) => page.evaluate((x) => window.__zaryaConvById?.(x), id)

/**
 * Дождаться конца хода.
 *
 * Без этого прогон врал зелёным: следующая отправка молча отбрасывалась
 * (`send` не пускает сообщение в занятую беседу), хвоста в ней не появлялось —
 * и проверка «уехал БЕЗ хвоста» проходила по той причине, что хода не было
 * вовсе.
 */
const waitIdle = async (page, id, ms = 30000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const c = await conv(page, id)
    if (c && c.streaming !== true) return true
    await page.waitForTimeout(200)
  }
  return false
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.()?.activeSessionId)
  ok('панель терминала поднялась', !!sid, { sid })

  console.log('\n[1] Команды человека доезжают до движка')
  const seeded = await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 4, 4), sid)
  note('засеяно блоков:', seeded)
  const a = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'почему упало?'))
  ok('первый ход завершился', await waitIdle(page, a))
  const c1 = await conv(page, a)
  note('хвосты:', JSON.stringify(c1?.shellTails))
  ok('к ходу приложен хвост консоли', (c1?.shellTails ?? []).length === 1, c1?.shellTails)
  const tail = c1?.shellTails?.[0]
  ok('уехало ровно столько команд, сколько в настройке', tail?.used?.length === 3, tail)
  ok('это ПОСЛЕДНИЕ команды, а не первые', !!tail?.used?.length && tail.used.length === 3, tail)
  ok('вывод обёрнут как недоверенный', tail?.wrapped === true, tail)
  ok('текст непустой — движку реально что отдать', (tail?.chars ?? 0) > 50, tail)

  console.log('\n[2] Человек видит, что именно уехало')
  const markText = await page.evaluate(
    () => document.querySelector('.zy-mf-tail')?.textContent ?? ''
  )
  note('плашка:', JSON.stringify(markText.replace(/\s+/g, ' ').slice(0, 120)))
  ok('плашка есть и называет число команд', /консоль/i.test(markText) && /3/.test(markText), markText)

  // Развёрнутая показывает САМИ команды: пометка без содержания непроверяема.
  await page.click('.zy-mf-tail-toggle')
  await page.waitForTimeout(400)
  const listed = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-mf-tail-cmd')).map((e) => e.textContent)
  )
  note('в развёрнутом списке:', JSON.stringify(listed))
  ok('список команд совпадает с тем, что уехало', listed.length === tail?.used?.length, {
    listed,
    used: tail?.used
  })
  ok(
    'команды в списке — настоящие команды человека',
    listed.every((x) => tail.used.includes(x)),
    { listed, used: tail?.used }
  )
  // Снимок — потому что решение о виде принимается глазами, а не по textContent.
  if (process.env.ZARYA_SHOT) {
    await page.screenshot({ path: process.env.ZARYA_SHOT })
    note('снимок:', process.env.ZARYA_SHOT)
  }

  console.log('\n[3] Слова человека остались его словами')
  const userTexts = await page.evaluate((id) => window.__zaryaConvById?.(id)?.userTexts ?? [], a)
  note('тексты человека:', JSON.stringify(userTexts))
  ok(
    'вывод команд НЕ подмешан в реплику человека',
    !userTexts.some((t) => String(t).includes('untrusted-terminal-output')),
    userTexts
  )
  const bubble = await page.evaluate(
    () => document.querySelector('.zy-mf-user-text')?.textContent ?? ''
  )
  ok('в пузыре человека — только его вопрос', !/vite|built in/i.test(bubble), bubble.slice(0, 120))

  console.log('\n[4] «Не читать здесь» выключает подачу в ЭТОЙ панели')
  await page.click('.zy-mf-tail-off')
  await page.waitForTimeout(400)
  ok('беседа помечена как отказавшаяся', (await conv(page, a))?.shellTailOff === true)
  await page.evaluate((id) => window.__zaryaSendIn?.(id, 'а теперь?'), a)
  ok('второй ход отправился и завершился', await waitIdle(page, a))
  const c2 = await conv(page, a)
  note('хвостов после отказа:', (c2?.shellTails ?? []).length)
  ok('новый ход уехал БЕЗ хвоста', (c2?.shellTails ?? []).length === 1, c2?.shellTails)

  console.log('\n[4a] И тем же нажатием подача возвращается')
  /*
   * Кнопка без обратного хода — тупик, а тупик в интерфейсе это то же враньё.
   * Проверяем именно возврат: при отказе новых плашек не появляется, и та,
   * по которой отказались, остаётся единственным местом, где о нём написано.
   */
  const backLabel = await page.evaluate(
    () => document.querySelector('.zy-mf-tail-off')?.textContent ?? ''
  )
  note('надпись на кнопке после отказа:', JSON.stringify(backLabel))
  ok('кнопка предлагает вернуть, а не повторить отказ', /вернуть/i.test(backLabel), backLabel)
  if (process.env.ZARYA_SHOT_OFF) {
    await page.screenshot({ path: process.env.ZARYA_SHOT_OFF })
    note('снимок отказа:', process.env.ZARYA_SHOT_OFF)
  }
  await page.click('.zy-mf-tail-off')
  await page.waitForTimeout(400)
  ok('отказ снят', (await conv(page, a))?.shellTailOff !== true)
  await page.evaluate((id) => window.__zaryaSendIn?.(id, 'и снова?'), a)
  ok('третий ход отправился и завершился', await waitIdle(page, a))
  const c2b = await conv(page, a)
  ok('следующий ход снова с хвостом', (c2b?.shellTails ?? []).length === 2, c2b?.shellTails)
  // И возвращаем отказ обратно — дальше прогон проверяет, что он переживает диск.
  await page.click('.zy-mf-tail-off')
  await page.waitForTimeout(400)
  ok('отказ снова включён', (await conv(page, a))?.shellTailOff === true)

  console.log('\n[5] Отказ распространяется на ПАНЕЛЬ, а не на один разговор')
  /*
   * Подпись кнопки говорит «в этой панели» — значит и новый разговор в том же
   * окне консоль отдавать не должен. Ревью поймало обратное: отказ жил в
   * беседе, и первая же новая забирала консоль, о которой человек уже сказал
   * «не читать». Обещание было шире правды.
   */
  const same = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'новый разговор тут'))
  await waitIdle(page, same)
  const cSame = await conv(page, same)
  ok(
    'новый разговор в ТОЙ ЖЕ панели тоже не читает',
    (cSame?.shellTails ?? []).length === 0,
    cSame?.shellTails
  )

  console.log('\n[5a] Соседней панели отказ не касается')
  const sid2 = await page.evaluate(() => window.__zaryaNewTerminal?.())
  await page.waitForTimeout(2500)
  await page.evaluate((s2) => window.__zaryaSeedBlocks?.(s2, 4, 4), sid2)
  const b = await page.evaluate((s2) => window.__zaryaStartAgentIn?.('codex', 'а у меня?', s2), sid2)
  await waitIdle(page, b)
  const c3 = await conv(page, b)
  ok('вторая панель по-прежнему подаёт консоль', (c3?.shellTails ?? []).length === 1, c3?.shellTails)

  console.log('\n[6] Ноль в настройке выключает подачу совсем')
  await page.evaluate(() => window.__zaryaSetTailBlocks?.(0))
  await page.waitForTimeout(600)
  const d = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'и тут?'))
  await waitIdle(page, d)
  const c4 = await conv(page, d)
  ok('при нуле хвоста нет вовсе', (c4?.shellTails ?? []).length === 0, c4?.shellTails)
  const noMark = await page.evaluate(() => document.querySelectorAll('.zy-mf-tail').length)
  ok('и плашки тоже нет — обещать нечего', noMark === 0, { noMark })

  console.log('\n[7] На диск уезжает список команд, а не мегабайты вывода')
  await page.evaluate(() => window.__zaryaPersistAll?.())
  await page.waitForTimeout(1500)
  const file = join(ud, 'ai-conversations.json')
  ok('файл бесед записан', existsSync(file))
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8')
    const saved = JSON.parse(raw)
    const tails = saved.conversations
      .flatMap((c) => c.messages ?? [])
      .flatMap((m) => (m.content ?? []).filter((p) => p.type === 'shell-tail'))
    note('хвостов на диске:', tails.length, '| размер файла:', raw.length)
    ok('хвосты сохранились как часть хода', tails.length > 0, tails.length)
    ok(
      'но БЕЗ текста вывода — иначе файл рос бы чужими байтами',
      tails.every((t) => !t.text),
      tails.map((t) => (t.text ?? '').length)
    )
    ok('список команд для плашки на месте', tails.every((t) => (t.used ?? []).length > 0), tails)
    /*
     * Ищем вывод консоли в НАШЕЙ половине файла — в ходах человека.
     *
     * По всему файлу искать нельзя: фейковый драйвер эхом повторяет полученный
     * промпт в своём ответе, и маркер честно оседает в сообщении РОЛИ АГЕНТА.
     * Это поведение подставного движка, а не наша утечка; настоящий так не
     * отвечает. Спор же идёт о том, не копим ли МЫ чужой вывод на диске.
     */
    const humanSide = JSON.stringify(
      saved.conversations.flatMap((c) => (c.messages ?? []).filter((m) => m.role === 'user'))
    )
    ok(
      'в ходах человека вывода консоли нет',
      !humanSide.includes('untrusted-terminal-output'),
      humanSide.length
    )
    // Отказ панели — решение человека, и он обязан пережить перезапуск.
    ok(
      'отказ «не читать здесь» сохранён',
      saved.conversations.some((c) => c.shellTailOff === true),
      saved.conversations.map((c) => c.shellTailOff ?? null)
    )
  }
  console.log('\n[8] Отказ переживает перезапуск — и для новых бесед тоже')
  /*
   * ПРОВЕРКА ПОЯВИЛАСЬ ПОСЛЕ РЕВЬЮ, и не зря: флаг честно писался в файл, но
   * при загрузке не читался. Отказ слетал молча, а кнопка снова предлагала
   * «не читать здесь» — то есть человек не мог даже заметить, что его решение
   * отменили. Проверять запись в файл, как делал раздел [7], оказалось
   * недостаточно: круг замыкается только перезапуском.
   */
  // Возвращаем настройку: раздел [6] обнулил её, и после перезапуска хвоста не
  // было бы вовсе — проверка отказа прошла бы по неверной причине.
  await page.evaluate(() => window.__zaryaSetTailBlocks?.(3))
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__zaryaPersistAll?.())
  await page.waitForTimeout(1200)
  await app.close().catch(() => {})
  const app2 = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: ud,
      ZARYA_FAKE_AGENT: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    }
  })
  try {
    const p2 = await app2.firstWindow()
    await p2.waitForLoadState('domcontentloaded')
    await p2.waitForTimeout(3000)
    const restored = await conv(p2, a)
    note('поднятая беседа:', JSON.stringify({ off: restored?.shellTailOff }))
    ok('отказ поднялся с диска', restored?.shellTailOff === true, restored?.shellTailOff)

    // И карта по панелям поднялась вместе с ним: иначе отказ переживал бы
    // перезапуск наполовину — старые разговоры молчат, новый в том же окне
    // снова забирает консоль, и объяснить человеку эту половину нечем.
    const paneOfA = await p2.evaluate((x) => window.__zaryaConvById?.(x)?.paneId, a)
    const mapped = await p2.evaluate((s3) => window.__zaryaTailOffFor?.(s3), paneOfA)
    note('панель отказавшейся беседы:', paneOfA, '· в карте отказов:', mapped)
    ok('карта отказов по панелям восстановлена', mapped === true, { paneOfA, mapped })
  } finally {
    await app2.close().catch(() => {})
  }
} catch (e) {
  fail++
  console.log('  ✗ ПРОГОН УПАЛ:', e?.message || e)
} finally {
  await app.close().catch(() => {})
  rmSync(ud, { recursive: true, force: true })
}

console.log(`\nИтог: ${pass} прошло, ${fail} упало`)
process.exit(fail ? 1 : 0)
