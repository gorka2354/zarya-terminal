/** Chip screenshot for every engine, side by side, to check the glyphs differ. */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const out = join(root, 'shots')
const userData = mkdtempSync(join(tmpdir(), 'zarya-eng-'))

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)

  for (const engine of ['shell', 'zarya', 'claude-code', 'codex', 'gemini', 'kimi', 'qwen']) {
    await page.evaluate((m) => window.__zaryaSetUi?.({ barMode: m }), engine)
    await page.waitForTimeout(250)
    const chip = await page.$('.zy-agentbar-mode')
    if (!chip) {
      console.log(engine, '— чипа нет')
      continue
    }
    await chip.screenshot({ path: join(out, `engine-${engine}.png`) })
    console.log('→', `engine-${engine}.png`)
  }
} finally {
  await app.close()
}
