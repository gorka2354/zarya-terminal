/**
 * Долгая команда докладывает (inc-31) — на живом окне.
 *
 * Две вещи, которых терминалу не хватало. Первая: сборка идёт восемь минут,
 * человек уходит в браузер и возвращается через двадцать — половину этого
 * времени терминал простоял с готовым ответом. Вторая: четыре панели в одном
 * проекте назывались одинаково, хотя `ssh prod` и `vim` подписывают себя сами.
 *
 * Уведомление ОС из прогона не увидеть, поэтому проверяется то, что ему
 * предшествует, и то, что решает, звать или нет: заголовок вкладки от программы
 * и правило «имя человека сильнее».
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-long-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-long-work-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}

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

/** Название панели так, как его видит человек. */
const titleOf = (page, sid) =>
  page.evaluate(
    (id) => (window.__zaryaDumpSessions?.()?.sessions ?? []).find((s) => s.id === id)?.title ?? '',
    sid
  )

/**
 * Отправить в панель сырую последовательность — так это делает программа.
 * ESC и BEL собираем кодами: в исходнике прогона литеральные управляющие знаки
 * нечитаемы и ломаются от любой правки файла.
 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const emit = (page, sid, body) =>
  page.evaluate(([id, s]) => window.__zaryaFeedTerm?.(id, s), [sid, ESC + body + BEL])

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)
  const sid = await page.evaluate((cwd) => window.__zaryaNewTerminal?.(cwd), work)
  await page.waitForTimeout(2500)

  console.log('\n[1] Программа подписывает вкладку сама (OSC 0 / OSC 2)')
  const before = await titleOf(page, sid)
  await emit(page, sid, ']2;ssh prod')
  await page.waitForTimeout(600)
  ok('заголовок от OSC 2 принят', (await titleOf(page, sid)) === 'ssh prod', {
    before,
    after: await titleOf(page, sid)
  })
  await emit(page, sid, ']0;vim заметки.md')
  await page.waitForTimeout(600)
  ok('и от OSC 0 тоже', (await titleOf(page, sid)) === 'vim заметки.md', await titleOf(page, sid))

  console.log('\n[2] Мусор в заголовок не проходит')
  // Программа может прислать в заголовок что угодно, а подпись вкладки — это
  // наш экран: управляющие знаки в ней превращаются в кашу. Собираем их
  // кодами — литеральные знаки в исходнике прогона нечитаемы и теряются от
  // любой правки файла.
  const junk = 'плохой' + String.fromCharCode(1) + String.fromCharCode(9) + 'заголовок'
  await emit(page, sid, `]2;${junk}`)
  await page.waitForTimeout(600)
  const clean = await titleOf(page, sid)
  const hasControl = [...clean].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)
  ok('управляющих знаков в подписи нет', !hasControl, JSON.stringify(clean))
  ok('а сам текст остался', /плохой/.test(clean) && /заголовок/.test(clean), clean)
  const long = 'о'.repeat(200)
  await emit(page, sid, `]2;${long}`)
  await page.waitForTimeout(600)
  const cut = await titleOf(page, sid)
  ok('длинный заголовок обрезан, а не растянул вкладки', cut.length <= 61, cut.length)

  console.log('\n[3] Имя, данное человеком, сильнее программы')
  await page.evaluate(
    ([id]) => window.__zaryaRenameSession?.(id, 'моё имя'),
    [sid]
  )
  await page.waitForTimeout(700)
  await emit(page, sid, ']2;ssh other')
  await page.waitForTimeout(700)
  ok('программа не перебила имя человека', (await titleOf(page, sid)) === 'моё имя', await titleOf(page, sid))
  if (shots) await page.screenshot({ path: join(shots, 'osc-title.png') })

  console.log('\n[4] Тумблеры уведомлений разведены')
  // Один гейт на оба означал бы, что выключение зова агента молча гасит и зов
  // о законченной команде.
  const s = await page.evaluate(() => window.__zaryaSettings?.()?.notifications ?? null)
  ok('настройка «долгая команда» существует', s && 'whenLongDone' in s, s)
  ok('и по умолчанию включена', s?.whenLongDone === true, s)
  ok('рядом с настройкой про агента, а не вместо неё', s?.whenWaiting === true, s)

  console.log(`\n[long-command] PASS ${pass} · FAIL ${fail}`)
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
