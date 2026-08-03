/**
 * Переход на модель со словарём.
 *
 * У прежней модели в словаре 34 токена: пробел и 33 строчные русские буквы. Ни
 * цифр, ни латиницы, ни знаков препинания — «git commit» и «cd 2» ей физически
 * не выговорить. Новая (тот же GigaAM v3, то же семейство, тот же размер, MIT)
 * знает 257 токенов.
 *
 * Главное требование к переходу: у того, кто уже скачал 225 МБ, ничего не должно
 * сломаться и ничего не должно качаться само. Прежняя модель остаётся рабочей,
 * а обновление словаря предлагается явной кнопкой.
 *
 * Наличие модели проверяется по точному размеру файлов, поэтому в песочнице
 * достаточно создать файлы нужной длины — 225 МБ качать незачем.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync } from 'node:fs'
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

const LEGACY = { dir: 'gigaam-v3-ru', files: { 'model.int8.onnx': 224721476, 'tokens.txt': 196 } }
const CURRENT = {
  dir: 'gigaam-v3-ru-punct',
  files: { 'model.int8.onnx': 224893661, 'tokens.txt': 2007 }
}
const MOONSHINE = {
  dir: 'moonshine-tiny-en',
  files: {
    'preprocess.onnx': 6800738,
    'encode.int8.onnx': 18249187,
    'uncached_decode.int8.onnx': 53216096,
    'cached_decode.int8.onnx': 45264830,
    'tokens.txt': 436688
  }
}

/** Файлы точного размера — ровно то, что проверяет present(). */
function placeModel(userData, m) {
  const dir = join(userData, 'models', m.dir)
  mkdirSync(dir, { recursive: true })
  for (const [name, size] of Object.entries(m.files)) {
    const p = join(dir, name)
    writeFileSync(p, '')
    truncateSync(p, size)
  }
}

async function stateWith(models, settings) {
  const userData = mkdtempSync(join(tmpdir(), 'zarya-stt-'))
  for (const m of models) placeModel(userData, m)
  if (settings) {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings), 'utf8')
  }
  const app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: { ...process.env, ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2500)
    return await page.evaluate(() => window.zarya.stt.state())
  } finally {
    await app.close()
  }
}

try {
  console.log('\n[1] Чистая установка: модели нет')
  const empty = await stateWith([])
  ok('модель не готова', empty.modelReady === false, empty)
  ok('прежней тоже нет', empty.legacyModel === false, empty)

  console.log('\n[2] Только ПРЕЖНЯЯ модель — диктовка обязана работать')
  const legacy = await stateWith([LEGACY])
  ok('распознавание доступно', legacy.modelReady === true, legacy)
  ok('но помечено как прежняя версия', legacy.legacyModel === true, legacy)

  console.log('\n[3] Новая модель')
  const fresh = await stateWith([CURRENT])
  ok('распознавание доступно', fresh.modelReady === true, fresh)
  ok('пометки об устаревании нет', fresh.legacyModel === false, fresh)

  console.log('\n[4] Обе рядом — предпочитается новая')
  const both = await stateWith([LEGACY, CURRENT])
  ok('распознавание доступно', both.modelReady === true, both)
  ok('прежняя не считается активной', both.legacyModel === false, both)

  console.log('\n[5] Английская модель — другое семейство, пять файлов')
  const moon = await stateWith([MOONSHINE], { voice: { modelId: 'moonshine-tiny-en' } })
  ok('распознавание доступно', moon.modelReady === true, moon)
  ok('активна именно она', moon.activeModelId === 'moonshine-tiny-en', moon.activeModelId)

  console.log('\n[6] Выбрана английская, а скачана только русская')
  // Выбор в настройках не должен ломать диктовку до конца скачивания.
  const fallback = await stateWith([CURRENT], { voice: { modelId: 'moonshine-tiny-en' } })
  ok('диктовка не сломалась', fallback.modelReady === true, fallback)
  ok(
    'взята скачанная, а не выбранная',
    fallback.activeModelId === 'gigaam-v3-ru-punct',
    fallback.activeModelId
  )

  console.log('\n[7] Список моделей для настроек')
  const list = await stateWith([CURRENT])
  const ids = (list.models ?? []).map((m) => m.id)
  ok(
    'показаны все скачиваемые',
    ids.includes('moonshine-tiny-en') && ids.includes('gigaam-v3-ru-rnnt'),
    ids
  )
  ok('прошлая версия скрыта, пока её нет на диске', !ids.includes('gigaam-v3-ru-legacy'), ids)
  const withLegacy = await stateWith([LEGACY])
  ok(
    'и показана, когда она есть',
    (withLegacy.models ?? []).some((m) => m.id === 'gigaam-v3-ru-legacy')
  )
  const moonRow = (list.models ?? []).find((m) => m.id === 'moonshine-tiny-en')
  // Вес по ОДНОМУ файлу был бы враньём: у moonshine их пять.
  ok('вес считается по всем файлам', moonRow?.bytes === 123967539, moonRow?.bytes)

  console.log(`\n[stt-migration] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  fail++
  console.log('  ✗ прогон упал:', e?.message)
}
process.exit(fail ? 1 : 0)
