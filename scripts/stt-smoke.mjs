/**
 * Dictation wiring smoke-test. Does NOT need a microphone or the 225 MB model:
 * it checks that the IPC surface exists, that the button renders, and that
 * transcribe() rejects malformed input instead of trusting the renderer.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-stt-'))
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

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  console.log('\n[1] IPC-поверхность на месте')
  const api = await page.evaluate(() => ({
    has: typeof window.zarya?.stt?.transcribe === 'function',
    state: typeof window.zarya?.stt?.state === 'function'
  }))
  ok('window.zarya.stt.transcribe есть', api.has)
  ok('window.zarya.stt.state есть', api.state)

  console.log('\n[2] Состояние до загрузки модели — честное, без падения')
  const st = await page.evaluate(() => window.zarya.stt.state())
  ok('modelReady=false на чистом профиле', st.modelReady === false, st)
  ok('engineReady=false', st.engineReady === false, st)

  console.log('\n[3] transcribe отвергает мусор, а не доверяет рендереру')
  const bad = await page.evaluate(async () => ({
    empty: await window.zarya.stt.transcribe(new Float32Array(0), 16000),
    rate: await window.zarya.stt.transcribe(new Float32Array(16), 1),
    huge: await window.zarya.stt.transcribe(new Float32Array(48000 * 400), 48000)
  }))
  ok('пустая запись отклонена', bad.empty.ok === false, bad.empty)
  ok('битая частота отклонена', bad.rate.ok === false, bad.rate)
  ok('слишком длинная запись отклонена', bad.huge.ok === false, bad.huge)

  console.log('\n[4] Кнопка диктовки в баре')
  const mic = await page.evaluate(() => {
    const b = document.querySelector('.zy-agentbar-mic')
    return b ? { title: b.getAttribute('title')?.slice(0, 40), svg: !!b.querySelector('svg') } : null
  })
  ok('кнопка есть и с иконкой', !!mic?.svg, mic)

  console.log(`\n[stt-smoke] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
