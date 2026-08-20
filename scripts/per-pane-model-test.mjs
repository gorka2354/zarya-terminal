/**
 * Модель — у каждой панели своя, и пол под автопилотом одинаков для движков.
 *
 *   node scripts/per-pane-model-test.mjs
 *
 * ПОВОД (разведка 2026-08-19).
 *
 * 1. В каждом ходе КАЖДОЙ панели уезжала одна глобальная настройка, а движок
 *    переключал живую сессию на входе хода. Сменил модель в одной панели —
 *    соседняя молча переехала на неё же; при этом подпись под строкой ввода у
 *    соседней пер-панельная и обновляется по ответу движка, то есть говорила
 *    прежнее. Интерфейс показывал HAIKU ровно в тот миг, когда ход уходил на
 *    OPUS.
 *
 * 2. Пол под автопилотом (`@shared/irreversible`) читали три драйвера, а Codex
 *    в автопилоте просто не спрашивал вовсе. Обещание же в интерфейсе одно на
 *    все движки: и подпись чипа, и строка «показано несмотря на автопилот».
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-model-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-model-w-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    ai: { claudeModel: 'gpt-5-codex-mini', claudeEffort: 'low' }
  })
)

/*
 * ДВИЖОК — ПОДСТАВНОЙ `codex`, и это не мелочь: `ZARYA_FAKE_AGENT` подменяет
 * только codex и gemini, а `claude-code` остаётся настоящим. Первая версия
 * прогона звала claude-code, тот в пустом окружении не запускался вовсе — и
 * журнал ходов оставался пустым, а прогон винил закрепление модели.
 *
 * Смотрим НА ВХОД ДРАЙВЕРА, а не на экран.
 *
 * Подпись под строкой ввода пер-панельная и обновляется по ответу движка — то
 * есть показывает прошлое. Спор идёт ровно о том, с какой моделью ход УШЁЛ, и
 * единственное честное место для ответа — журнал подставного драйвера.
 */
const startLog = join(ud, 'starts.jsonl')

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_FAKE_START_LOG: startLog,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

/** С какой моделью ушёл ПОСЛЕДНИЙ ход этой беседы. */
const sentModel = (convId) => {
  let rows = []
  try {
    rows = readFileSync(startLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x))
  } catch {
    return null
  }
  const mine = rows.filter((r) => r.requestId === convId)
  return mine.length ? (mine[mine.length - 1].model ?? null) : null
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Две панели, обе начинают с настройки')
  const sidA = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  const convA = await page.evaluate(
    (s) => window.__zaryaStartAgentIn?.('codex', 'привет', s),
    sidA
  )
  await page.waitForTimeout(1500)
  const sidB = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  const convB = await page.evaluate(
    (s) => window.__zaryaStartAgentIn?.('codex', 'привет', s),
    sidB
  )
  await page.waitForTimeout(1500)
  try {
    const raw = readFileSync(startLog, 'utf8').split('\n').filter(Boolean)
    note('журнал:', raw.slice(0, 3).join(' | ').slice(0, 400))
  } catch (e) {
    note('журнала нет:', String(e).slice(0, 120))
  }
  const startA = sentModel(convA)
  const startB = sentModel(convB)
  note('ушло у A:', JSON.stringify(startA), '· у B:', JSON.stringify(startB))
  ok('обе взяли модель из настройки', startA === 'gpt-5-codex-mini' && startB === startA, {
    startA,
    startB
  })

  console.log('\n[2] Смена модели в одной панели НЕ уводит соседнюю')
  await page.evaluate(
    (c) => window.__zaryaSetConvModel?.(c, 'gpt-5-codex-max', 'high'),
    convA
  )
  await page.waitForTimeout(300)
  await page.evaluate((c) => window.__zaryaSendIn?.(c, 'ещё раз'), convA)
  await page.waitForTimeout(1800)
  await page.evaluate((c) => window.__zaryaSendIn?.(c, 'ещё раз'), convB)
  await page.waitForTimeout(1800)
  const afterA = sentModel(convA)
  const afterB = sentModel(convB)
  note('ушло у A:', JSON.stringify(afterA), '· у B:', JSON.stringify(afterB))
  ok('панель A ушла на выбранную модель', afterA === 'gpt-5-codex-max', afterA)
  ok('панель B осталась на своей', afterB === 'gpt-5-codex-mini', afterB)

  console.log('\n[3] Настройка — это «чем начинать новые», а не «чем работают все»')
  await page.evaluate(() =>
    window.zarya.settings.set({ ai: { claudeModel: 'gpt-5-codex' } })
  )
  await page.waitForTimeout(500)
  await page.evaluate((c) => window.__zaryaSendIn?.(c, 'и снова'), convB)
  await page.waitForTimeout(1800)
  const bAfterSettings = sentModel(convB)
  note('у B после смены настройки:', JSON.stringify(bAfterSettings))
  ok('живая беседа не переехала следом за настройкой', bAfterSettings === 'gpt-5-codex-mini', bAfterSettings)

  const sidC = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  const convC = await page.evaluate(
    (s) => window.__zaryaStartAgentIn?.('codex', 'привет', s),
    sidC
  )
  await page.waitForTimeout(1500)
  const startC = sentModel(convC)
  note('новая беседа начала с:', JSON.stringify(startC))
  ok('а новая беседа взяла новую настройку', startC === 'gpt-5-codex', startC)
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

console.log(`\n[per-pane-model] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
