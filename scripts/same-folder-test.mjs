/**
 * Две панели в одной папке — человек об этом узнаёт.
 *
 *   node scripts/same-folder-test.mjs
 *
 * ЕДИНСТВЕННОЕ МЕСТО, ГДЕ РАБОТА ТЕРЯЕТСЯ МОЛЧА. Два агента в одной папке
 * правят одни файлы, и правка второго ложится поверх первой; узнаёт человек об
 * этом позже всех. Агенту про соседа говорит `list_panes` (это проверяет
 * tests/paneTools.test.ts), а здесь проверяется вторая половина: строка в шапке
 * той панели, где названа сама папка.
 *
 * И ГЛАВНОЕ — ЧЕГО ОНА НЕ ОБЕЩАЕТ. Заря файлы не блокирует; строка говорит
 * «работает рядом», а не «конфликт предотвращён».
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-folder-'))
const workA = mkdtempSync(join(tmpdir(), 'zarya-folder-a-'))
const workB = mkdtempSync(join(tmpdir(), 'zarya-folder-b-'))
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
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

/**
 * Все пометки «та же папка», какие сейчас на экране.
 *
 * По классу, а не по тексту: сперва прогон искал `[title]` и считал заодно
 * родительскую зону хватания — каждая пометка выходила дважды, а подсказкой
 * оказывалась чужая. Проверка врала не про фичу, а про себя.
 */
const chips = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.zy-pane-together')].map((el) => el.textContent ?? '')
  )

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Один терминал в папке — предупреждать не о чем')
  const s1 = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), workA)
  await page.waitForTimeout(2000)
  ok('панель открылась', !!s1, { s1 })
  ok('пометки нет', (await chips(page)).length === 0, await chips(page))

  console.log('\n[2] Второй терминал в той же папке — но агентов ещё нет')
  /*
   * Два ТЕРМИНАЛА в одной папке — обычная работа человека, и кричать о ней
   * каждый день значило бы приучить не читать эту строку вовсе.
   */
  const s2 = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), workA)
  await page.waitForTimeout(2000)
  ok('вторая панель открылась', !!s2 && s2 !== s1, { s1, s2 })
  ok('и всё ещё тихо', (await chips(page)).length === 0, await chips(page))

  console.log('\n[3] В обеих работает агент — вот теперь сказать надо')
  await page.evaluate((s) => window.__zaryaStartAgentIn?.('codex', 'привет', s), s1)
  await page.waitForTimeout(1500)
  await page.evaluate((s) => window.__zaryaStartAgentIn?.('codex', 'привет', s), s2)
  await page.waitForTimeout(2500)
  const seen = await chips(page)
  note('на экране:', JSON.stringify(seen))
  ok('пометка появилась у обеих панелей', seen.length === 2, seen)

  const why = await page.evaluate(
    () => document.querySelector('.zy-pane-together')?.getAttribute('title') ?? ''
  )
  note('подсказка:', JSON.stringify(why))
  ok('сказано, что файлы НЕ блокируются', /не блокирует/.test(why), why)
  ok('и сказано, чем это грозит', /ляжет поверх/.test(why), why)
  ok('но не обещано, что конфликт предотвращён', !/предотвращ|защищ/i.test(why), why)

  if (process.env.ZARYA_SHOT_DIR) {
    await page.screenshot({ path: join(process.env.ZARYA_SHOT_DIR, 'same-folder.png') })
    note('снимок: same-folder.png')
  }

  console.log('\n[4] Разные папки — молчим')
  const s3 = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), workB)
  await page.waitForTimeout(2000)
  await page.evaluate((s) => window.__zaryaStartAgentIn?.('codex', 'привет', s), s3)
  await page.waitForTimeout(2500)
  const after = await chips(page)
  note('на экране:', JSON.stringify(after))
  ok('у третьей панели пометки нет', after.length === 2, after)
  ok(
    'и она не названа соседкой первых двух',
    !after.some((x) => x.includes('+1')),
    after
  )
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  for (const d of [ud, workA, workB]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка останется — не повод падать */
    }
  }
}

console.log(`\n[same-folder] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
