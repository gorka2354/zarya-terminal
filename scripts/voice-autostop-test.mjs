/**
 * Режим «одна фраза» обязан заканчиваться сам.
 *
 *   node scripts/voice-autostop-test.mjs
 *
 * Отчёт владельца: «микрофон вставляет слова не сразу, а только после второго
 * нажатия». Причина — флаг «клавишу держат»: он поднимался нажатием
 * Ctrl+Shift+Space и снимался отпусканием пробела, а если окно теряло фокус
 * между этими событиями, `keyup` уходил другому окну и флаг застревал. С этого
 * мига автостоп по тишине не срабатывал НИКОГДА.
 *
 * Проверяется настоящим звуком: Chromium подменяет микрофон на WAV-файл
 * (`--use-file-for-fake-audio-capture`), распознаёт НАСТОЯЩАЯ модель GigaAM из
 * профиля. Прогон нажимает значок ОДИН раз и ждёт: текст обязан появиться в
 * строке сам.
 *
 * Профиль изолирован, но модель весит 214 МБ — её берём копией из настоящего
 * профиля (только чтение), иначе прогон качал бы её заново каждый раз.
 */
import { _electron as electron } from 'playwright'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
  return !!cond
}
const note = (...a) => console.log('   ·', ...a)

const WAV = process.env.ZARYA_FAKE_WAV || ''
if (!WAV || !existsSync(WAV)) {
  console.log('ПРОПУЩЕНО: нет файла речи. Укажите ZARYA_FAKE_WAV=<путь к 16-бит WAV>')
  process.exit(2)
}

const realModels = join(homedir(), 'AppData', 'Roaming', 'Zarya', 'models')
if (!existsSync(realModels)) {
  console.log('ПРОПУЩЕНО: модель распознавания не скачана — проверять нечем')
  process.exit(2)
}

const ud = mkdtempSync(join(tmpdir(), 'zarya-voice-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-voicew-'))
mkdirSync(join(work, 'src'), { recursive: true })
writeFileSync(join(work, 'src', 'a.txt'), 'файл\n', 'utf8')
// Копия модели: настоящий профиль остаётся нетронутым, а прогон не качает 214 МБ.
note('копирую модель в изолированный профиль…')
cpSync(realModels, join(ud, 'models'), { recursive: true })
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    // Режим задаётся ЯВНО: этот прогон про автостоп по молчанию, а он живёт
    // только здесь. По умолчанию диктовка теперь потоковая и не заканчивается
    // сама — это её обещание, и проверяет его voice-modes-test.
    voice: { mode: 'phrase' }
  })
)

const app = await electron.launch({
  args: [
    join(process.cwd(), 'out', 'main', 'index.js'),
    // Микрофон подменяется файлом: разрешение не спрашивается, звук зациклен.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`
  ],
  env: {
    ...process.env,
    ZARYA_USER_DATA: ud,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  // Молчаливый провал ничего не объясняет: ошибки страницы — первое, что стоит
  // увидеть, когда «кнопка нажата, а ничего не произошло».
  page.on('console', (m) => {
    if (/error|warn/i.test(m.type())) console.log('   [консоль]', m.type(), m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => console.log('   [ошибка страницы]', String(e).slice(0, 200)))
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1280, 860)
    w.center()
  })
  await page.waitForTimeout(3000)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.waitForTimeout(600)

  console.log('\n[1] Флаг удержания «залипает» после потерянного keyup')
  /*
   * Воспроизводим ровно ту поломку: нажатие горячей клавиши приходит, а
   * отпускание — нет (окно потеряло фокус, комбинацию перехватила система).
   */
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true })
    )
  })
  await page.waitForTimeout(1200)
  // Запись, начатую клавишей, гасим — нас интересует следующая, со значка.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.waitForTimeout(2500)
  ok('приложение живо после залипшей клавиши', true)

  console.log('\n[2] Нажимаем значок ОДИН раз и ждём — текст обязан прийти сам')
  const VIS = `(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    return {
      area: [...document.querySelectorAll('.zy-agentbar textarea')].filter(vis)[0] ?? null,
      mic: [...document.querySelectorAll('.zy-agentbar-mic')].filter(vis)[0] ?? null,
      note: [...document.querySelectorAll('.zy-agentbar-voicenote')].filter(vis)[0] ?? null
    }
  })()`
  const before = await page.evaluate(`${VIS}.area?.value ?? ''`)
  note('в строке до диктовки:', JSON.stringify(before))
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.zy-agentbar-mic')].filter((el) =>
      el.checkVisibility ? el.checkVisibility() : !!el.offsetParent
    )[0]
    if (!b) return { found: false }
    const info = { found: true, disabled: b.disabled === true, title: b.title ?? '' }
    b.click()
    return info
  })
  note('кнопка:', JSON.stringify(clicked))
  ok('значок микрофона нажат', clicked.found === true && clicked.disabled !== true, clicked)
  // Устройства глазами страницы: пустой список объяснил бы всё сразу.
  const devs = await page.evaluate(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      return list.filter((d) => d.kind === 'audioinput').map((d) => d.label || d.deviceId)
    } catch (e) {
      return ['ОШИБКА: ' + String(e)]
    }
  })
  note('микрофоны:', JSON.stringify(devs))

  // Ждём: речь (~5 с) + тишина 1.5 с + распознавание. Второго нажатия НЕТ.
  // Попутно печатаем, что видно на экране: молчаливый провал здесь ничего не
  // объясняет, а объяснить он обязан — иначе прогон бесполезен.
  const t0 = Date.now()
  let text = before
  let lastState = ''
  for (;;) {
    const st = await page.evaluate(`(() => {
      const v = ${VIS}
      return {
        text: v.area?.value ?? '',
        micClass: v.mic?.className ?? '(нет кнопки)',
        note: v.note?.textContent ?? ''
      }
    })()`)
    text = st.text
    const line = `${st.micClass} | заметка: ${st.note}`
    if (line !== lastState) {
      note(`+${Math.round((Date.now() - t0) / 1000)}с:`, line.slice(0, 150))
      lastState = line
    }
    if (text !== before) break
    if (Date.now() - t0 > 60000) break
    await page.waitForTimeout(500)
  }
  note('ждали, с:', Math.round((Date.now() - t0) / 1000))
  note('в строке после:', JSON.stringify(text.slice(0, 120)))
  ok('текст появился БЕЗ второго нажатия', text !== before, { было: before, стало: text })
  // Микрофон обязан отпуститься сам: иначе соседние панели останутся без него.
  const still = await page.evaluate(
    `${VIS}.mic?.classList.contains('zy-agentbar-mic--rec') === true`
  )
  ok('запись завершилась сама', !still)
} finally {
  await app.close()
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка */
    }
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
