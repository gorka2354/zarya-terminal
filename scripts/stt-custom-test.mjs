/**
 * Своя модель распознавания: путь от «выбрал папку» до строки в настройках.
 *
 * Движок здесь не поднимается — файлы пустые, и это нарочно: проверяется всё,
 * что происходит ДО него. Именно там живут ответы на вопросы «что это за
 * модель», «не уводит ли манифест чтение наружу» и «что случится с чужими
 * файлами, когда модель уберут из списка».
 *
 * Системный диалог выбора папки из Playwright не нажимается, поэтому главный
 * процесс берёт путь из ZARYA_STT_PICK_DIR — рубильник ровно для прогонов.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

console.log('\n[1] Папка Whisper опознаётся сама')
{
  const app = await launch(WHISPER)
  const page = await boot(app)
  const res = await add(page)
  ok('модель добавлена', res.ok === true, res)
  ok('имя взято из папки', res.model?.name === 'sherpa-onnx-whisper-small', res.model)

  const st = await state(page)
  const mine = st.models.filter((m) => m.custom)
  ok('в списке ровно одна своя модель', mine.length === 1, st.models.length)
  ok('она помечена своей и найдена на диске', mine[0]?.installed === true, mine[0])
  ok('вес посчитан по файлам', mine[0]?.bytes === 3005, mine[0]?.bytes)
  ok('путь показан человеку', mine[0]?.dir === WHISPER, mine[0]?.dir)
  ok('она сразу стала активной', st.activeModelId === mine[0]?.id, st.activeModelId)
  ok('диктовка считает себя готовой', st.modelReady === true, st.modelReady)
  await app.close()
}

console.log('\n[2] Выбор переживает перезапуск')
{
  const app = await launch()
  const page = await boot(app)
  const st = await state(page)
  const mine = st.models.filter((m) => m.custom)
  ok('своя модель на месте после перезапуска', mine.length === 1, st.models.length)
  ok('и по-прежнему активна', st.activeModelId === mine[0]?.id, st.activeModelId)

  // Строка в настройках: человек видит имя, а не идентификатор.
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(400)
  await page.click('.zy-settings-nav-item:has-text("Голос")')
  await page.waitForTimeout(400)
  const shown = await page.evaluate(() => document.body.innerText)
  ok('имя своей модели видно в настройках', shown.includes('sherpa-onnx-whisper-small'))
  ok('оговорка про ответственность на месте', shown.includes('за качество распознавания не ручается'))
  await app.close()
}

console.log('\n[3] Манифест главнее догадок')
{
  const app = await launch(MANIFESTED)
  const page = await boot(app)
  const res = await add(page)
  ok('папка с манифестом принята', res.ok === true, res)
  ok('имя из манифеста, а не из папки', res.model?.name === 'Моя NeMo', res.model)
  const st = await state(page)
  ok('теперь своих моделей две', st.models.filter((m) => m.custom).length === 2)
  await app.close()
}

console.log('\n[4] Отказы честные')
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
  const st = await state(page)
  ok('и в список не попал', st.models.filter((m) => m.custom).length === 2, st.models.length)
  await app.close()
}

console.log('\n[5] «Убрать» не трогает чужие файлы')
{
  const app = await launch()
  const page = await boot(app)
  const before = await state(page)
  const mine = before.models.filter((m) => m.custom)
  const target = mine.find((m) => m.dir === WHISPER)
  const gone = await page.evaluate((id) => window.zarya.stt.forgetCustom(id), target.id)
  ok('убрана из списка', gone.ok === true, gone)

  const after = await state(page)
  ok('в списке осталась одна своя', after.models.filter((m) => m.custom).length === 1)
  ok('файлы на диске целы', existsSync(join(WHISPER, 'small-encoder.int8.onnx')))

  // Удалить свою модель через «удалить с диска» нельзя даже намеренно.
  const other = after.models.find((m) => m.custom)
  const refused = await page.evaluate((id) => window.zarya.stt.removeModel(id), other.id)
  ok('удаление чужих файлов отклонено', refused.ok === false, refused)
  ok('и объяснено', String(refused.error).includes('не удаляет чужие файлы'), refused.error)
  ok('модель осталась в списке', (await state(page)).models.filter((m) => m.custom).length === 1)
  await app.close()
}

console.log(`\n[stt-custom] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
