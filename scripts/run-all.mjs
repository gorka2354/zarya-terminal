/**
 * Полный прогон офлайн-сценариев — то, что перед каждым выпуском гонялось
 * руками, поимённо.
 *
 *   node scripts/run-all.mjs            # весь офлайн-набор
 *   node scripts/run-all.mjs пан        # только сценарии, чьё имя содержит «пан»
 *
 * Отдельный раннер, а не npm-скрипт с перечислением: список в package.json
 * устаревал бы молча — новый сценарий просто не попадал бы в выпускной прогон,
 * и об этом никто бы не узнал. Здесь набор берётся с диска.
 *
 * Что СЮДА НЕ ВХОДИТ и почему: сценарии, которые шлют ход НАСТОЯЩЕМУ Claude —
 * они тратят токены подписки и требуют живого входа. Определяются по коду
 * (см. `goesLive`), а не по имени файла. Для них свой раннер:
 * `node scripts/live/run-live.mjs`, плюс поимённо.
 *
 * Исключённое ПЕЧАТАЕТСЯ в итоге, вместе с тем, что сценарии пропустили сами:
 * набор, который молча сузился, читается как «всё проверено», хотя проверено
 * не всё.
 *
 * Перед прогоном нужен `npm run build` — сценарии поднимают собранное
 * приложение из `out/`, иначе проверяется прошлая сборка.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { join } from 'node:path'

const dir = join(process.cwd(), 'scripts')
const filter = process.argv[2] ?? ''
/** Сценарий на один Electron редко идёт дольше двух минут; вставший — не повод стоять всем. */
const TIMEOUT_MS = Number(process.env.ZARYA_RUN_TIMEOUT ?? 240_000)

/**
 * Ходит ли сценарий к НАСТОЯЩЕМУ движку.
 *
 * Смотрим в код, а не на имя файла. Первая версия делила по имени («-live»,
 * «cc-») и обозвала офлайн-набором прогон, в котором десять сценариев слали
 * настоящие ходы Claude: `session-test`, `queue-test`, `fuel-test` и другие
 * называются как обычные, а токены подписки тратят как живые. Имя — не
 * свойство сценария; свойство — то, кого он зовёт.
 */
function goesLive(file) {
  const src = readFileSync(join(dir, file), 'utf8')
  if (/ZARYA_FAKE_AGENT/.test(src)) return false
  return /__zaryaAskAgent|__zaryaStartAgent/.test(src) && /claude-code/.test(src)
}

const all = readdirSync(dir).filter((f) => f.endsWith('-test.mjs'))
const live = all.filter(goesLive)
const skipped = new Set(live)
const scenarios = all.filter((f) => !skipped.has(f) && f.includes(filter))

/*
 * СКОЛЬКО ОСТАЛОСЬ МАШИНЫ.
 *
 * Прогон поднимает Electron под сотню раз подряд, каждый до полугигабайта, и
 * идёт двадцать с лишним минут. 2026-08-26 он шёл на машине, где владелец в
 * соседнем окне держал два воркфлоу Claude Code: свободными оставались 6 ГБ из
 * 63, и его сессия умерла. Доказать причинность не вышло, но запускать вслепую
 * то, что съедает чужую работу, нельзя.
 *
 * Раннер не спрашивает — он не интерактивен, и вопрос в пустоту завис бы. Он
 * ОТКАЗЫВАЕТСЯ и называет, сколько нужно; `--anyway` берёт решение на себя.
 */
const GB = 1024 ** 3
const freeGb = freemem() / GB
const NEED_GB = Number(process.env.ZARYA_RUN_NEED_GB ?? 12)
const anyway = process.argv.includes('--anyway')
console.log(
  `Свободно памяти: ${freeGb.toFixed(1)} ГБ из ${(totalmem() / GB).toFixed(0)} · ` +
    `набор поднимет Electron ${scenarios.length} раз`
)
if (freeGb < NEED_GB && !anyway) {
  console.log(
    `\nОТКАЗ: для прогона нужно ${NEED_GB} ГБ свободных, есть ${freeGb.toFixed(1)}.\n` +
      `Соседняя тяжёлая работа (агенты, сборки, браузеры) может не пережить.\n` +
      `Закройте лишнее — или запустите с «--anyway», если решаете иначе.`
  )
  process.exit(2)
}

console.log(`Офлайн-набор: ${scenarios.length} сценариев`)
if (filter) console.log(`Фильтр: «${filter}»`)

const failed = []
const slow = []
/*
 * Сценарий вправе сказать «проверять нечем» — голосовым нужен файл речи
 * (`ZARYA_FAKE_WAV`) и скачанная модель, микрофонным — живое устройство.
 * Это НЕ падение и НЕ успех: засчитать такое зелёным значило бы отчитаться о
 * проверке, которой не было. Считаем отдельной третьей кучей и печатаем её.
 */
const skippedBySelf = []
let done = 0
for (const name of scenarios) {
  done++
  process.stdout.write(`\n[${done}/${scenarios.length}] ${name} `)
  const started = process.hrtime.bigint()
  /*
   * Окружение НЕ навязываем. Первая версия ставила всем `ZARYA_QA_OFFSCREEN=1`,
   * чтобы окна не мигали, — и повалила `window-memory-test`: он проверяет ровно
   * то, что за краем экрана положение окна не записывается, а последний его шаг
   * обязан окно ПОКАЗАТЬ. Раннер, который решает за сценарий, каким тому быть,
   * проверяет собственную выдумку.
   */
  const r = spawnSync(process.execPath, [join(dir, name)], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS
  })
  const secs = Number(process.hrtime.bigint() - started) / 1e9
  if (secs > 60) slow.push(`${name} (${secs.toFixed(0)} с)`)
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  /*
   * Сколько проверок внутри сценария упало.
   *
   * Форматов ДВА, и они не сговаривались: «Итог: 22 прошло, 0 упало» и
   * «[имя] PASS 23 · FAIL 0». Одной регуляркой на оба я уже обжёгся: она
   * цеплялась за «FAIL 0», а вторым числом хватала номер СЛЕДУЮЩЕГО шага —
   * `[8] Разрешение выдано…` — и прошедший сценарий объявлялся упавшим на
   * восьми проверках. Раннер, который врёт про чужой результат, хуже, чем
   * его отсутствие: он заставляет чинить то, что не сломано.
   *
   * Поэтому каждый формат разбирается своим выражением, и берётся ПОСЛЕДНЕЕ
   * совпадение: сценарии печатают промежуточные итоги по разделам, а
   * настоящий — в самом низу.
   */
  const lastOf = (re) => {
    const all = [...out.matchAll(re)]
    return all.length ? all[all.length - 1] : null
  }
  const said =
    lastOf(/Итог:\s*(\d+)\s*прошло,\s*(\d+)\s*упало/g) ??
    lastOf(/PASS\s+(\d+)\s*[·|]?\s*FAIL\s+(\d+)/g)
  const inner = said ? Number(said[2]) : 0
  const bad = r.status !== 0 || inner > 0
  const saidSkip = /ПРОПУЩЕНО|SKIPPED/.test(out)
  if (r.error?.code === 'ETIMEDOUT') {
    failed.push(`${name} — не уложился в ${TIMEOUT_MS / 1000} с`)
    process.stdout.write('⏱ ЗАВИС')
  } else if (saidSkip && inner === 0) {
    const why = out.match(/ПРОПУЩЕНО:?\s*(.+)/)?.[1]?.trim() ?? 'без причины'
    skippedBySelf.push(`${name} — ${why}`)
    process.stdout.write('— пропущен')
  } else if (bad) {
    failed.push(`${name}${inner ? ` — упало проверок: ${inner}` : ` — код ${r.status}`}`)
    process.stdout.write('✗')
    // Хвост вывода упавшего — иначе придётся перезапускать его вручную, чтобы
    // просто узнать, что случилось.
    console.log('\n' + out.split('\n').slice(-14).join('\n'))
  } else {
    process.stdout.write('✓')
  }
}

console.log(`\n\n${'═'.repeat(58)}`)
console.log(
  `Прошло: ${scenarios.length - failed.length - skippedBySelf.length} · ` +
    `Упало: ${failed.length} · Пропущено самими сценариями: ${skippedBySelf.length}`
)
for (const f of failed) console.log('  ✗', f)
for (const s of skippedBySelf) console.log('  —', s)
// Голосовым нужен файл речи, и он не лежит в репозитории — его синтезирует
// `voice-suite`. Без этой строки пропуск читался бы как «голос проверен».
if (skippedBySelf.some((s) => /WAV|речи/i.test(s)))
  console.log('  голос целиком (речь синтезируется на месте): node scripts/voice-suite.mjs')
if (slow.length) console.log(`Дольше минуты: ${slow.join(', ')}`)
console.log(
  `НЕ входили — ходят к настоящему Claude (${skipped.size}): ${[...skipped].join(', ')}\n` +
    `  живой набор целиком — node scripts/live/run-live.mjs (тратит токены подписки)`
)
process.exit(failed.length ? 1 : 0)
