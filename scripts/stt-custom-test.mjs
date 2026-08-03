/**
 * Своя модель распознавания: разбор папки и отказы.
 *
 * Настоящих весов здесь нет — файлы пустые, и это нарочно. Проверяется, что
 * Заря на них НЕ соглашается: с некоторых пор папка не просто разбирается по
 * именам, а проверяется попыткой собрать движок в отдельном процессе, и пустой
 * .onnx эту проверку не проходит. Отсюда и главное требование прогона: отказ
 * должен быть словами, а приложение — остаться живым.
 *
 * Требование не выдумано. Нативный sherpa-onnx на модели не той формы не
 * возвращает ошибку: он вызывает exit(-1) из рабочего потока, и приложение
 * исчезает целиком, вместе с панелями, терминалами и агентами.
 *
 * Полный путь на НАСТОЯЩЕЙ модели (добавили → выбрали → распознали) проверяет
 * scripts/stt-custom-live.mjs: ему нужно 100 МБ весов, поэтому он живёт
 * отдельно и в CI не гоняется.
 *
 * Системный диалог выбора папки из Playwright не нажимается, поэтому главный
 * процесс берёт путь из ZARYA_STT_PICK_DIR — рубильник ровно для прогонов.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'zarya-stt-custom-'))
const userData = join(sandbox, 'userData')
mkdirSync(userData, { recursive: true })
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

/** Папка «как с HuggingFace»: имена настоящие, содержимое пустое. */
const makeDir = (name, files) => {
  const dir = join(sandbox, name)
  mkdirSync(dir, { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body ?? '')
  return dir
}

const WHISPER = makeDir('sherpa-onnx-whisper-small', {
  'small-encoder.int8.onnx': 'x'.repeat(1000),
  'small-decoder.int8.onnx': 'x'.repeat(2000),
  'small-tokens.txt': 'a b c'
})
const NAMELESS = makeDir('моя-модель', {
  'model.onnx': 'x'.repeat(100),
  'tokens.txt': 'a'
})
const ESCAPING = makeDir('sherpa-onnx-escape', {
  'model.onnx': 'x',
  'tokens.txt': 'a',
  'zarya-model.json': JSON.stringify({
    name: 'Побег',
    family: 'nemoCtc',
    files: { model: '../../secrets.onnx', tokens: 'tokens.txt' }
  })
})
const MANIFESTED = makeDir('папка-с-манифестом', {
  'weights.onnx': 'x'.repeat(500),
  'vocab.txt': 'a',
  'zarya-model.json': JSON.stringify({
    name: 'Моя NeMo',
    lang: 'RU',
    family: 'nemoCtc',
    files: { model: 'weights.onnx', tokens: 'vocab.txt' }
  })
})

const launch = (pick) =>
  electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ...(pick ? { ZARYA_STT_PICK_DIR: pick } : {}),
      NODE_ENV: 'production'
    }
  })

/** Открыть окно и дождаться готовности интерфейса. */
const boot = async (app) => {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.zarya, null, { timeout: 30000 })
  return page
}

const add = (page) => page.evaluate(() => window.zarya.stt.addCustom())
const state = (page) => page.evaluate(() => window.zarya.stt.state())

console.log('\n[1] Пустые файлы не выдаются за модель')
{
  const app = await launch(WHISPER)
  const page = await boot(app)
  const res = await add(page)
  // Имена настоящие, содержимое — нет. Раньше этого хватало, чтобы модель
  // «добавилась»: интерфейс обещал работающую диктовку, а первое нажатие
  // микрофона убивало приложение.
  ok('папка с пустыми весами отклонена', res.ok === false, res)
  ok('отказ назван словами', String(res.error || '').length > 10, res.error)
  ok('в список ничего не попало', (await state(page)).models.filter((m) => m.custom).length === 0)
  ok('приложение живо', (await page.evaluate(() => 2 + 2)) === 4)
  await app.close()
}

console.log('\n[2] Секция «своя модель» на месте и объясняет себя')
{
  const app = await launch()
  const page = await boot(app)
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(400)
  await page.click('.zy-settings-nav-item:has-text("Голос")')
  await page.waitForTimeout(400)
  // innerText отдаёт текст ПОСЛЕ text-transform, а кнопки набраны прописными —
  // сравнение регистрозависимое здесь ловило бы стиль, а не наличие кнопки.
  const shown = await page.evaluate(() => document.body.innerText)
  const flat = shown.toLowerCase()
  ok('кнопка выбора папки видна', flat.includes('указать папку'))
  ok('сказано, что ничего не копируется', flat.includes('ничего не копируется'))
  ok('про манифест сказано там же', flat.includes('zarya-model.json'))
  await app.close()
}

console.log('\n[3] Манифест разбирается, но пустые веса не спасает')
{
  const app = await launch(MANIFESTED)
  const page = await boot(app)
  const res = await add(page)
  ok('папка с манифестом тоже отклонена — веса пустые', res.ok === false, res)
  // Важно, ЧТО именно сказано: разбор манифеста прошёл (иначе речь была бы про
  // сам json), споткнулся движок — значит проверка дошла до запуска.
  ok('отказ не про разбор манифеста', !String(res.error || '').includes('не разбирается'), res.error)
  ok('приложение живо', (await page.evaluate(() => 2 + 2)) === 4)
  await app.close()
}

console.log('\n[4] Отказы честные и объясняют, что делать')
{
  const app = await launch(NAMELESS)
  const page = await boot(app)
  const res = await add(page)
  ok('одинокий model.onnx без подсказки — отказ', res.ok === false, res)
  ok('отказ объясняет, что делать', String(res.error).includes('zarya-model.json'), res.error)
  await app.close()
}
{
  const app = await launch(ESCAPING)
  const page = await boot(app)
  const res = await add(page)
  // Главная проверка этого прогона: манифест не читает файлы вне своей папки.
  ok('манифест с «..» отвергнут', res.ok === false, res)
  ok('отказ именно про имя файла', String(res.error).includes('именем внутри папки'), res.error)
  const st = await state(page)
  ok('и в список не попал', st.models.filter((m) => m.custom).length === 0, st.models.length)
  await app.close()
}

console.log('\n[5] «Убрать» не трогает чужие файлы')
{
  // Запись кладём прямо в настройки: так выглядит модель, добавленная раньше,
  // на машине, где веса лежат на месте. Проверяем судьбу ФАЙЛОВ, а не разбор.
  const before = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  before.voice = {
    ...(before.voice || {}),
    modelId: 'custom:seeded',
    customModels: [
      {
        id: 'custom:seeded',
        name: 'Принесённая',
        lang: 'EN',
        family: 'whisper',
        dir: WHISPER,
        files: {
          encoder: 'small-encoder.int8.onnx',
          decoder: 'small-decoder.int8.onnx',
          tokens: 'small-tokens.txt'
        },
        bytes: 3005
      }
    ]
  }
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(before, null, 2))

  const app = await launch()
  const page = await boot(app)
  const st = await state(page)
  const mine = st.models.filter((m) => m.custom)
  ok('своя модель из настроек видна', mine.length === 1, st.models.length)
  ok('и подписана именем человека', mine[0]?.name === 'Принесённая', mine[0])

  const refused = await page.evaluate((id) => window.zarya.stt.removeModel(id), mine[0].id)
  ok('удаление чужих файлов отклонено', refused.ok === false, refused)
  ok('и объяснено', String(refused.error).includes('не удаляет чужие файлы'), refused.error)

  const gone = await page.evaluate((id) => window.zarya.stt.forgetCustom(id), mine[0].id)
  ok('убрана из списка', gone.ok === true, gone)
  ok('в списке своих не осталось', (await state(page)).models.filter((m) => m.custom).length === 0)
  ok('файлы на диске целы', existsSync(join(WHISPER, 'small-encoder.int8.onnx')))
  await app.close()
}

console.log(`\n[stt-custom] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
