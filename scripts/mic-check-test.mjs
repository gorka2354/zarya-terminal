/**
 * Проверка микрофона в настройках: показывает ли она правду.
 *
 *   ZARYA_FAKE_WAV=<wav> node scripts/mic-check-test.mjs
 *
 * Смысл этого экрана — ответить на вопрос «он меня слышит?» без гадания. Значит
 * проверять надо не наличие кнопки, а то, что цифры на нём живые и совпадают с
 * тем, по каким законам диктовка решает, что фраза кончилась.
 *
 * Микрофон подменяется файлом (Chromium), распознаёт настоящая модель из
 * профиля — та же, что и в рабочей строке.
 */
import { _electron as electron } from 'playwright'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const shots = process.env.ZARYA_SHOTS || ''

const WAV = process.env.ZARYA_FAKE_WAV || ''
const models = join(homedir(), 'AppData', 'Roaming', 'Zarya', 'models')
if (!WAV || !existsSync(WAV) || !existsSync(models)) {
  console.log('ПРОПУЩЕНО: нужен ZARYA_FAKE_WAV и скачанная модель — проверять нечем')
  process.exit(2)
}

const ud = mkdtempSync(join(tmpdir(), 'zarya-miccheck-'))
cpSync(models, join(ud, 'models'), { recursive: true })
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [
    join(process.cwd(), 'out', 'main', 'index.js'),
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

const vis = (page, sel) =>
  page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].filter((e) =>
      e.checkVisibility ? e.checkVisibility() : !!e.offsetParent
    )[0]
    return el ? (el.textContent ?? '') : null
  }, sel)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1280, 880)
    w.center()
  })
  await page.waitForTimeout(3000)

  console.log('\n[1] Проверка стоит на вкладке «Голос», рядом с выбором устройства')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'voice' }))
  await page.waitForTimeout(1800)
  const idle = await vis(page, '.zy-miccheck')
  ok('блок проверки на экране', idle !== null, idle)
  ok('до нажатия — приглашение, а не пустота', /скажите фразу/i.test(idle ?? ''), idle)
  if (shots) await page.screenshot({ path: join(shots, 'miccheck-1-idle.png') })

  console.log('\n[2] Нажали — шкала живая, вердикт совпадает со словами диктовки')
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.zy-miccheck .zy-btn')].filter((e) =>
      e.checkVisibility ? e.checkVisibility() : !!e.offsetParent
    )[0]
    b?.click()
  })
  await page.waitForTimeout(2500)
  const during = await vis(page, '.zy-miccheck')
  note('во время записи:', (during ?? '').replace(/\s+/g, ' ').slice(0, 120))
  ok('сказано, что слышит речь', /Слышу речь|Слушаю/.test(during ?? ''), during)
  const width = await page.evaluate(
    () => document.querySelector('.zy-miccheck-fill')?.style.width ?? ''
  )
  note('заполнение шкалы:', width)
  ok('шкала не стоит на нуле', width !== '' && width !== '0%', width)
  ok('порог показан числом', /порог речи: \d+/.test(during ?? ''), during)
  if (shots) await page.screenshot({ path: join(shots, 'miccheck-2-live.png') })

  console.log('\n[3] Фраза кончилась сама, и текст показан словами')
  const t0 = Date.now()
  let done = ''
  for (;;) {
    done = (await vis(page, '.zy-miccheck')) ?? ''
    if (/Разобрано:|слов не разобрано/.test(done)) break
    if (Date.now() - t0 > 60000) break
    await page.waitForTimeout(500)
  }
  note('итог:', done.replace(/\s+/g, ' ').slice(0, 200))
  // Второго нажатия не было: запись обязана закончиться по тишине сама.
  ok('расшифровка появилась без второго нажатия', /Разобрано:/.test(done), done.slice(0, 200))
  ok('и это настоящие слова', /провер|микрофон|привет/i.test(done), done.slice(0, 200))
  if (shots) await page.screenshot({ path: join(shots, 'miccheck-3-result.png') })
} finally {
  await app.close()
  try {
    rmSync(ud, { recursive: true, force: true })
  } catch {
    /* временная папка */
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
