/**
 * Актуальные модели и режим, который переживает перезапуск.
 *
 * Два дефекта, найденные владельцем на живом экране:
 *
 * 1. В пусковом комплексе для встроенного борта список моделей был
 *    захардкожен — вышел Opus 5, а человек по-прежнему выбирал из Opus 4.8.
 * 2. Режим бара не сохранялся: поработал в Claude Code, перезапустил — и
 *    оказался в оболочке, ничего не выбирая. Из-за этого он и попал на первый
 *    дефект, хотя работал с подпиской, а не по ключу.
 *
 *   npm run build && node scripts/models-test.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-models-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify(
    { appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'workspace' } },
    null,
    2
  )
)

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

const launch = () =>
  electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: { ...process.env, ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
  })

let app = await launch()
try {
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  console.log('\n[1] Каталог берётся у провайдера, а не из памяти кода')
  const wired = await page.evaluate(() => typeof window.zarya.ai.listModels === 'function')
  ok('канал каталога есть', wired)
  // Без ключа спросить некого — и это должно быть сказано, а не выдано за
  // пустой список: интерфейс не врёт о том, чего не знает.
  const noKey = await page.evaluate(() => window.zarya.ai.listModels('anthropic'))
  ok('без ключа приходит честный ответ с ошибкой', !!noKey?.error, noKey)
  ok('и пустой список, а не выдуманный', (noKey?.ids ?? []).length === 0, noKey)

  console.log('\n[2] Новая модель показывается один раз')
  // Первый каталог запоминается молча: рассказывать «появились» про всё сразу
  // значит превратить новость в список.
  await page.evaluate(() =>
    window.__zaryaModelNews?.('anthropic', ['claude-opus-5', 'claude-sonnet-5'])
  )
  await page.waitForTimeout(400)
  ok(
    'на первом каталоге окна нет',
    await page.evaluate(() => !document.querySelector('[data-model-news]'))
  )

  await page.evaluate(() =>
    window.__zaryaModelNews?.('anthropic', ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5'])
  )
  await page.waitForTimeout(500)
  const news = await page.evaluate(() => {
    const el = document.querySelector('[data-model-news]')
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null
  })
  ok('новая модель показана', !!news, news)
  ok('и названа по-человечески', /Fable 5/.test(news ?? ''), news)
  ok('старые модели в окно не попали', !/Sonnet/.test(news ?? ''), news)

  await page.evaluate(() =>
    window.__zaryaModelNews?.('anthropic', ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5'])
  )
  await page.waitForTimeout(400)
  const again = await page.evaluate(() => {
    const el = document.querySelector('[data-model-news]')
    return el ? el.textContent : null
  })
  ok('второй раз про ту же модель не сообщает', again === news, { again, news })

  console.log('\n[3] Режим бара переживает перезапуск')
  await page.evaluate(() => {
    const sid = window.__zaryaDumpSessions().activeSessionId
    window.__zaryaSetUi?.({ barMode: 'claude-code' })
    window.__zaryaSetPaneBarMode?.(sid, 'claude-code')
  })
  await page.waitForTimeout(600)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  ok(
    'режим выставлен',
    (await page.evaluate((s) => window.__zaryaBarModeFor?.(s), sid)) === 'claude-code'
  )
  await page.evaluate(() => window.__zaryaPersistAll?.())
  await page.waitForTimeout(1200)
  await app.close()

  app = await launch()
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.text().includes('[restore]')) console.log('  ', m.text())
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(4000)
  // Режим ПАНЕЛИ, а не общее умолчание окна: восстанавливается именно выбор,
  // сделанный в этой панели.
  const after = await page.evaluate(
    () => window.__zaryaBarModeFor?.(window.__zaryaDumpSessions().activeSessionId)
  )
  // Раньше здесь было 'shell': вчерашняя работа в Claude Code молча
  // превращалась в обычный терминал, и пусковой комплекс показывал каталог
  // совсем другого борта.
  ok('после перезапуска режим тот же', after === 'claude-code', after)
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* каталог мог не создаться */
  }
}

console.log(`\n[models] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
