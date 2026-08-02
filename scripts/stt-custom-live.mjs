/**
 * Своя модель распознавания на НАСТОЯЩИХ весах.
 *
 * Проверяет то, чего не проверить на пустышках: что модель, принесённая с
 * диска, действительно поднимает движок и распознаёт — и что модель, объявленная
 * не тем семейством, даёт слова отказа, а не смерть приложения.
 *
 * Второе — не теоретическая осторожность. sherpa-onnx, получив ONNX не той
 * формы, не возвращает ошибку: нативный код печатает строку и вызывает exit(-1)
 * из рабочего потока. В главном процессе это означает, что Заря исчезает
 * целиком — панели, терминалы, агенты и несохранённое состояние, — а выбор
 * модели остаётся в настройках, и следующий запуск умирает так же.
 *
 * Прогон качает Whisper tiny.en (~104 МБ) в кеш и в CI не гоняется: там нет ни
 * места, ни причины держать веса. Запуск: `npm run qa:voice-custom`.
 */
import { _electron as electron } from 'playwright'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { get } from 'node:https'
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

const CACHE = join(tmpdir(), 'zarya-stt-live-cache', 'sherpa-onnx-whisper-tiny.en')
const BASE = 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main'
const FILES = [
  ['tiny.en-encoder.int8.onnx', 12_921_267],
  ['tiny.en-decoder.int8.onnx', 89_919_477],
  ['tiny.en-tokens.txt', 816_730]
]

/** Скачать файл, если его ещё нет. HuggingFace отвечает редиректом на CDN. */
const download = (url, dest, hops = 0) =>
  new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('слишком много перенаправлений'))
    get(url, { headers: { 'user-agent': 'Zarya-QA' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return download(new URL(res.headers.location, url).toString(), dest, hops + 1).then(
          resolve,
          reject
        )
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const out = createWriteStream(dest)
      res.pipe(out)
      out.on('finish', resolve)
      out.on('error', reject)
    }).on('error', reject)
  })

mkdirSync(CACHE, { recursive: true })
for (const [name, size] of FILES) {
  const dest = join(CACHE, name)
  if (existsSync(dest) && statSync(dest).size === size) continue
  console.log('  качаю', name, `(${Math.round(size / 1e6)} МБ)`)
  await download(`${BASE}/${name}`, dest)
}
console.log('  веса на месте:', CACHE)

const userData = mkdtempSync(join(tmpdir(), 'zarya-live-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

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

const boot = async (app) => {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.zarya, null, { timeout: 40000 })
  return page
}

console.log('\n[1] Настоящая модель добавляется и работает')
{
  const app = await launch(CACHE)
  const page = await boot(app)
  const res = await page.evaluate(() => window.zarya.stt.addCustom())
  ok('модель принята', res.ok === true, res)
  ok('опознана как whisper', res.model?.family === 'whisper', res.model)

  const st = await page.evaluate(() => window.zarya.stt.state())
  ok('она активна', st.activeModelId === res.model?.id, st.activeModelId)

  // Секунда звука: движку хватает, чтобы собраться и ответить.
  const said = await page.evaluate(() => {
    const samples = new Float32Array(16000)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.02
    return window.zarya.stt.transcribe(samples, 16000)
  })
  ok('распознавание отвечает, а не падает', said.ok === true, said)
  ok('движок поднят', (await page.evaluate(() => window.zarya.stt.state())).engineReady === true)
  await app.close()
}

console.log('\n[2] Чужое семейство — слова отказа, а не смерть приложения')
{
  // Те же настоящие веса whisper, объявленные senseVoice. Раньше это убивало
  // главный процесс при ПЕРВОМ нажатии микрофона — и повторно после каждого
  // перезапуска, потому что выбор оставался в настройках.
  const LIE = join(tmpdir(), 'zarya-stt-live-cache', 'sense-voice-lie')
  mkdirSync(LIE, { recursive: true })
  for (const [name] of FILES) {
    const src = join(CACHE, name)
    const dst = join(LIE, name)
    if (!existsSync(dst)) copyFileSync(src, dst)
  }
  writeFileSync(
    join(LIE, 'zarya-model.json'),
    JSON.stringify({
      name: 'Подменённое семейство',
      family: 'senseVoice',
      files: { model: 'tiny.en-encoder.int8.onnx', tokens: 'tiny.en-tokens.txt' }
    })
  )

  const app = await launch(LIE)
  const page = await boot(app)
  const res = await page.evaluate(() => window.zarya.stt.addCustom())
  ok('модель отклонена', res.ok === false, res)
  ok('сказано, что семейство не то', String(res.error || '').includes('senseVoice'), res.error)
  ok('приложение живо', (await page.evaluate(() => 1 + 1)) === 2)
  // В списке уже лежит настоящая модель из первого блока — профиль общий.
  // Проверяем именно ту папку, которую сейчас отвергли.
  const list = (await page.evaluate(() => window.zarya.stt.state())).models
  ok('в список не попала', !list.some((m) => m.dir === LIE), list.filter((m) => m.custom).map((m) => m.dir))
  ok('прежняя рабочая модель осталась выбранной', list.some((m) => m.custom && m.installed))
  await app.close()
}

console.log(`\n[stt-custom-live] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
