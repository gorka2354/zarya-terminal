/**
 * Откат файлов — все исходы, которые придётся пережить.
 *
 * Живой e2e с настоящим Claude Code в CI не гоняется, а карточка отката обязана
 * честно ответить на каждый ответ движка: за ошибку здесь платит человек своими
 * файлами. Поэтому исходы разыгрывает фейковый драйвер — тот же контракт, те же
 * события, без токенов.
 *
 * Проверяется ровно то, что было бы враньём:
 * 1) пока идёт ход или висит вопрос разрешения — откат отказывает, а не портит
 *    файлы под работающим инструментом;
 * 2) выключенные чекпоинты движок сообщает ДВУМЯ разными способами (флагом на
 *    сухом прогоне и исключением на настоящем откате) — оба должны стать
 *    внятным ответом, а не «не получилось»;
 * 3) «откатить можно, но списка файлов нет» не превращается в пустой список,
 *    который читается как «ничего не изменится»;
 * 4) пропущенные ссылки называются числом, а не проглатываются;
 * 5) движок, который так не умеет, отвечает «unsupported» — кнопки там быть не
 *    должно.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
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

/** Один запуск приложения с заданным сценарием отката у фейка. */
async function withApp(mode, fn) {
  const userData = mkdtempSync(join(tmpdir(), 'zarya-rw-'))
  const work = mkdtempSync(join(tmpdir(), 'zarya-rww-'))
  // Прогон изолирован (ZARYA_USER_DATA), а копии лежат вне подменяемой папки —
  // значит чекпоинты выключены политикой, и точки отката не будет. Уводим
  // настройки движка в свою папку: это и есть разрешённое исключение.
  const claudeHome = mkdtempSync(join(tmpdir(), 'zarya-rwcfg-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
  )
  const app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: userData,
      CLAUDE_CONFIG_DIR: claudeHome,
      ZARYA_FAKE_AGENT: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      ...(mode ? { ZARYA_FAKE_REWIND: mode } : {}),
      NODE_ENV: 'production'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2400)
    await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
    await page.waitForTimeout(1500)
    await fn(page)
  } finally {
    await app.close()
  }
}

/** Ход фейку и точка отката этого хода. */
async function turnWithId(page, prompt = 'привет') {
  const cid = await page.evaluate((p) => window.__zaryaStartAgent?.('codex', p), prompt)
  await page.waitForTimeout(2000)
  const turnId = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return (c?.turnMarks ?? []).find((m) => m.role === 'user' && m.turnId)?.turnId ?? null
  }, cid)
  return { cid, turnId }
}

const call = (page, cid, turnId, dryRun) =>
  page.evaluate(
    ([id, uuid, dry]) => window.zarya.agent.rewindFiles('codex', id, uuid, { dryRun: dry }),
    [cid, turnId, dryRun]
  )

console.log('\n[1] Обычный откат: движок называет файлы и числа')
await withApp('ok', async (page) => {
  const { cid, turnId } = await turnWithId(page)
  ok('точка отката у хода есть', !!turnId, turnId)
  const dry = await call(page, cid, turnId, true)
  ok('сухой прогон разрешает', dry?.canRewind === true, dry)
  ok('и называет файлы', (dry?.filesChanged ?? []).length > 0, dry)
  const real = await call(page, cid, turnId, false)
  ok('настоящий откат отвечает числом пропущенных', real?.skippedLinks === 0, real)
})

console.log('\n[2] Без точки отката кнопке нечего делать')
await withApp('ok', async (page) => {
  const { cid } = await turnWithId(page)
  const out = await call(page, cid, '', true)
  // Пустой uuid — это наша собственная ошибка, и отвечать на неё надо отказом,
  // а не запросом к движку «откати неизвестно к чему».
  ok('отказ до движка', out?.refused === 'no-turn-id', out)
})

console.log('\n[3] Пока висит вопрос разрешения — откат отказывает')
await withApp('ok', async (page) => {
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(1500)
  const turnId = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return (c?.turnMarks ?? []).find((m) => m.role === 'user' && m.turnId)?.turnId ?? null
  }, cid)
  // Ход с инструментом поднимает карточку одобрения и оставляет её висеть.
  await page.evaluate(() => window.__zaryaFollowUp?.('tool: сделай что-нибудь'))
  await page.waitForTimeout(1600)
  const out = await call(page, cid, turnId, true)
  // Откат в этот момент вытащил бы файлы из-под ещё не принятого решения:
  // человек одобрил бы правку, которая ляжет уже на другой файл.
  ok('сказано «занято», а не выполнено', out?.refused === 'busy', out)
})

console.log('\n[4] Чекпоинты выключены: движок отвечает двумя разными способами')
await withApp('off', async (page) => {
  const { cid, turnId } = await turnWithId(page)
  const dry = await call(page, cid, turnId, true)
  ok('сухой прогон — флагом и словами движка', dry?.canRewind === false && !!dry?.error, dry)
  const real = await call(page, cid, turnId, false)
  // Настоящий откат БРОСАЕТ. Непойманное исключение здесь означало бы
  // «не получилось» вместо объяснения — и человек пошёл бы искать причину сам.
  ok('настоящий откат — пойманным исключением', real?.canRewind === false && !!real?.error, real)
  ok('текст движка сохранён дословно', /not enabled/i.test(real?.error ?? ''), real?.error)
})

console.log('\n[5] «Откатить можно, но файлы не назову» — это не пустой список')
await withApp('nofiles', async (page) => {
  const { cid, turnId } = await turnWithId(page)
  const dry = await call(page, cid, turnId, true)
  ok('движок разрешает', dry?.canRewind === true, dry)
  // Пустой список читается как «ничего не изменится» — знание, которого у нас
  // нет. Интерфейс обязан различать эти два случая, поэтому поле отсутствует.
  ok('списка файлов нет вовсе', dry?.filesChanged === undefined, dry)
})

console.log('\n[6] Пропущенные ссылки названы числом')
await withApp('links', async (page) => {
  const { cid, turnId } = await turnWithId(page)
  const real = await call(page, cid, turnId, false)
  ok('движок сообщил про пропуск', real?.skippedLinks === 1, real)
})

console.log('\n[7] Движок, который так не умеет: кнопки быть не должно')
await withApp('ok', async (page) => {
  const out = await page.evaluate(() =>
    window.zarya.agent.rewindFiles('gemini', 'no-such-request', 'uuid', { dryRun: true })
  )
  ok('ответ «движок так не умеет»', out?.refused === 'unsupported', out)
})

console.log('\n[8] Сухой прогон дополняется тем, чего движок не знает')
await withApp('ok', async (page, work) => {
  const { cid, turnId } = await turnWithId(page)
  const dry = await call(page, cid, turnId, true, work)
  // Движок называет только пути. Есть ли файл на диске, не ссылка ли это и не
  // лежит ли он вне папки агента — он молчит до самого конца, а человек
  // принимает решение ДО.
  ok('к путям приложены факты с диска', Array.isArray(dry?.facts), dry)
  ok(
    'факт есть на каждый путь',
    (dry?.facts ?? []).length === (dry?.filesChanged ?? []).length,
    dry?.facts
  )
  ok(
    'сказано, существует ли файл сейчас',
    (dry?.facts ?? []).every((f) => typeof f.existsNow === 'boolean'),
    dry?.facts
  )
})

console.log('\n[9] После настоящего отката считаем сами, а не верим числам движка')
await withApp('ok', async (page, work) => {
  const { cid, turnId } = await turnWithId(page)
  const real = await call(page, cid, turnId, false, work)
  ok('пост-сверка приложена к результату', !!real?.verdict, real)
  // Фейк на диске ничего не менял: значит файл остался прежним, и это НЕ
  // успех. Промолчать здесь — соврать уже после необратимого действия.
  ok('файл, до которого откат не дошёл, посчитан', real?.verdict?.untouched === 1, real?.verdict)
  ok('и назван поимённо', (real?.verdict?.untouchedPaths ?? []).length === 1, real?.verdict)
  ok('успехов не приписано', real?.verdict?.restored === 0, real?.verdict)
})

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
