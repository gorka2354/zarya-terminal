/** Capture the ClaudeQuestionBar (bottom bar morphed into the native selector). */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-ccs-'))
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
  await page.waitForTimeout(2500)
  await page.evaluate(() =>
    window.__zaryaAskAgent?.(
      'Через инструмент AskUserQuestion задай мне один вопрос «Какую тему выбрать для терминала?» с 4 вариантами: Космос, Плакат, Рассвет, Матрица — у каждого короткое описание. Ничего больше не делай.',
      'claude-code'
    )
  )
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await page.waitForTimeout(1200)
    const has = await page.evaluate(
      () => !!document.querySelector('.zy-cqb')
    )
    if (has) break
  }
  await page.waitForTimeout(400)
  mkdirSync(join(root, 'shots'), { recursive: true })
  await page.screenshot({ path: join(root, 'shots', 'cc-question.png') })
  console.log('shot: shots/cc-question.png')
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
