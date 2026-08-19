/**
 * Карточка чтения консоли называет КОМАНДУ, а не идентификатор.
 *
 *   node scripts/read-block-card-test.mjs
 *
 * ПОВОД. Карточка разрешения показывает аргументы вызова как есть, а у
 * `read_block` аргумент — это `id` блока. `{"id":"b17"}` человеку не говорит
 * ничего, и он одобряет чтение своей консоли вслепую. Команду Заря знает —
 * блоки лежат в том же окне.
 *
 * И ВТОРОЕ, БЕЗ ЧЕГО ПЕРВОЕ БЫЛО БЫ ВРАНЬЁМ: `id: "last"` значит «самый свежий
 * блок», а между нажатием человека и чтением может закончиться ещё одна
 * команда. Одобрение поэтому уезжает с УЖЕ РАЗРЕШЁННЫМ id — тем самым, который
 * карточка назвала.
 *
 * Движок здесь подставной: проверяется окно — что оно показывает и что
 * отправляет, — а не то, как настоящий агент зовёт инструмент (это живой
 * прогон scripts/live/block-tools.mjs).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-rbcard-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-rbcard-w-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_FAKE_AGENT: '1',
    // Подставной драйвер отвечает в ленту, что получил от окна: со стороны
    // окна это не увидеть — мост `window.zarya` заморожен.
    ZARYA_FAKE_ECHO_INPUT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

/** Просьба разрешения, как её присылает драйвер. */
const ask = (page, convId, toolUseId, input) =>
  page.evaluate(
    ([c, id, arg]) =>
      window.__zaryaAgentEvent?.(c, {
        type: 'permission',
        toolUseId: id,
        toolName: 'mcp__zarya__read_block',
        input: arg
      }),
    [convId, toolUseId, input]
  )

const cardText = (page) =>
  page.evaluate(
    () => document.querySelector('.zy-mf-tool-mark')?.textContent ?? ''
  )

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Панель с командами человека и живой беседой')
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  const seeded = await page.evaluate((s) => window.__zaryaSeedBlocks?.(s, 4, 4), sid)
  const conv = await page.evaluate((s) => window.__zaryaStartAgentIn?.('codex', 'привет', s), sid)
  await page.waitForTimeout(2000)
  ok('команды и беседа на месте', seeded > 0 && !!conv, { seeded, conv })

  const blocks = await page.evaluate((s) => window.__zaryaDumpBlocks?.(s), sid)
  const last = blocks[blocks.length - 1]
  const first = blocks[0]
  note('последняя команда панели:', JSON.stringify(last.command))

  console.log('\n[2] Обычное чтение: карточка называет команду, а не id')
  // Адресуем блок его идентификатором — ровно так, как это делает агент.
  await ask(page, conv, 'perm-1', { id: first.id })
  await page.waitForTimeout(800)
  const t1 = await cardText(page)
  note('на карточке:', JSON.stringify(t1))
  ok('названа команда, а не идентификатор', t1.includes(first.command), { t1, cmd: first.command })

  console.log('\n[3] «last»: карточка называет самую свежую')
  /*
   * Первую карточку отклоняем: одобрение ниже жмёт первую нерешённую, и с
   * двумя висящими прогон одобрил бы не ту, которую проверяет.
   */
  await page.evaluate(() => window.__zaryaDenyFirst?.())
  await page.waitForTimeout(500)
  await ask(page, conv, 'perm-2', { id: 'last' })
  await page.waitForTimeout(800)
  const t2 = await cardText(page)
  note('на карточке:', JSON.stringify(t2))
  ok('названа последняя команда', t2.includes(last.command), { t2, cmd: last.command })

  console.log('\n[4] Одобрение закрепляет ТУ ЖЕ команду')
  /*
   * Между нажатием и чтением может закончиться ещё одна команда — и агент
   * прочитал бы не то, что человек одобрил. Проверяем, что решение уезжает с
   * уже разрешённым id.
   */
  /*
   * Смотрим со стороны ДРАЙВЕРА: мост `window.zarya` заморожен, подменить его
   * вызов из страницы нельзя, поэтому подставной драйвер сам говорит вслух,
   * что получил (см. fakeAgentDriver.resolvePermission).
   */
  await page.evaluate((c) => window.__zaryaApproveIn?.(c), conv)
  await page.waitForTimeout(1200)
  const said = await page.evaluate((c) => {
    const conv = window.__zaryaConvById?.(c)
    return (conv?.notices ?? []).join(' | ')
  }, conv)
  note('драйвер получил:', JSON.stringify(said))
  ok('решение уехало с закреплённым блоком', /updatedInput/.test(said), said)
  ok('и это НЕ слово «last», а конкретный блок', new RegExp(last.id).test(said), {
    said,
    id: last.id
  })
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка останется — не повод падать */
    }
  }
}

console.log(`\n[read-block-card] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
