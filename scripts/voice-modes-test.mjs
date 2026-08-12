/**
 * Три режима диктовки: каждый ведёт себя так, как обещает.
 *
 *   ZARYA_FAKE_WAV=<две фразы через паузу> node scripts/voice-modes-test.mjs
 *
 * Просьба владельца после живой пробы: «нажал и говоришь, он сразу вводит; нажал
 * ещё раз — стоп». Проверяется главное свойство этого режима — текст появляется
 * ПОКА ЗАПИСЬ ИДЁТ, а не после её конца. Проверить это можно только настоящим
 * звуком с настоящей паузой: микрофон подменяется WAV-файлом, распознаёт та же
 * модель, что и в работе.
 *
 * Второй режим — «одна фраза» — обязан, наоборот, закрыться сам после паузы.
 * Третий — «нажал-говорю-нажал» — не резать и не закрываться вовсе.
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
const section = (s) => console.log(`\n${s}`)
const shots = process.env.ZARYA_SHOTS || ''

const WAV = process.env.ZARYA_FAKE_WAV || ''
const models = join(homedir(), 'AppData', 'Roaming', 'Zarya', 'models')
if (!WAV || !existsSync(WAV) || !existsSync(models)) {
  console.log('ПРОПУЩЕНО: нужен ZARYA_FAKE_WAV и скачанная модель — проверять нечем')
  process.exit(2)
}

/** Один запуск приложения с заданным режимом диктовки. */
async function withMode(mode, fn) {
  const ud = mkdtempSync(join(tmpdir(), 'zarya-vm-'))
  const work = mkdtempSync(join(tmpdir(), 'zarya-vmw-'))
  cpSync(models, join(ud, 'models'), { recursive: true })
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({
      appearance: { language: 'ru' },
      sessions: { restoreOnLaunch: 'none' },
      voice: { mode }
    })
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
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(1280, 880)
      w.center()
    })
    await page.waitForTimeout(3000)
    await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
    await page.waitForTimeout(2000)
    await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
    await page.waitForTimeout(600)
    await fn(page)
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
}

/** Видимая строка ввода и значок — панелей в окне несколько. */
const VIS = `(() => {
  const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
  return {
    area: [...document.querySelectorAll('.zy-agentbar textarea')].filter(vis)[0] ?? null,
    mic: [...document.querySelectorAll('.zy-agentbar-mic')].filter(vis)[0] ?? null
  }
})()`

const текст = (page) => page.evaluate(`${VIS}.area?.value ?? ''`)
const пишет = (page) =>
  page.evaluate(`${VIS}.mic?.classList.contains('zy-agentbar-mic--rec') === true`)
const нажать = (page) => page.evaluate(`${VIS}.mic?.click()`)

/** Ждать, пока в строке появится текст (или выйдет срок). */
async function ждатьТекст(page, было, ms) {
  const t0 = Date.now()
  for (;;) {
    const t = await текст(page)
    if (t !== было) return { text: t, ms: Date.now() - t0 }
    if (Date.now() - t0 > ms) return { text: t, ms: Date.now() - t0, timeout: true }
    await page.waitForTimeout(300)
  }
}

section('[1] «Нажал и говорю»: текст приходит ПОКА идёт запись')
await withMode('stream', async (page) => {
  await нажать(page)
  await page.waitForTimeout(500)
  ok('запись пошла', await пишет(page))

  const first = await ждатьТекст(page, '', 45000)
  note('первый текст через', Math.round(first.ms / 1000), 'с:', JSON.stringify(first.text))
  ok('текст появился без остановки записи', !first.timeout && first.text !== '', first)
  // Главное свойство режима: запись ПРОДОЛЖАЕТСЯ. Если она закрылась сама, это
  // уже «одна фраза», как бы ни называлась настройка.
  ok('микрофон всё ещё пишет', await пишет(page), first.text)
  if (shots) await page.screenshot({ path: join(shots, 'modes-1-stream.png') })

  const second = await ждатьТекст(page, first.text, 45000)
  note('второй кусок через', Math.round(second.ms / 1000), 'с:', JSON.stringify(second.text))
  ok('вторая фраза дописалась к первой', !second.timeout, second)
  ok('текст именно дописан, а не заменён', second.text.startsWith(first.text), second.text)

  await нажать(page)
  await page.waitForTimeout(4000)
  ok('второе нажатие остановило запись', !(await пишет(page)))
})

section('[2] «Одна фраза»: запись закрывается сама, текст один')
await withMode('phrase', async (page) => {
  await нажать(page)
  await page.waitForTimeout(500)
  const r = await ждатьТекст(page, '', 60000)
  note('текст через', Math.round(r.ms / 1000), 'с:', JSON.stringify(r.text))
  ok('текст пришёл', !r.timeout && r.text !== '', r)
  ok('и запись закрылась сама', !(await пишет(page)))
  if (shots) await page.screenshot({ path: join(shots, 'modes-2-phrase.png') })
})

section('[3] «Нажал-говорю-нажал»: тишина не режет и не заканчивает')
await withMode('hold', async (page) => {
  await нажать(page)
  await page.waitForTimeout(500)
  // Пауза между фразами длиннее любого порога — в этом режиме она обязана быть
  // просто паузой.
  await page.waitForTimeout(14000)
  ok('запись идёт, несмотря на паузу', await пишет(page))
  ok('в строке пусто — текст придёт в конце', (await текст(page)) === '', await текст(page))
  await нажать(page)
  const r = await ждатьТекст(page, '', 60000)
  note('после остановки:', JSON.stringify(r.text))
  ok('текст пришёл целиком после нажатия', !r.timeout && r.text !== '', r)
  if (shots) await page.screenshot({ path: join(shots, 'modes-3-hold.png') })
})

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
