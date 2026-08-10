/**
 * Рабочая папка на НАСТОЯЩЕМ Claude Code (inc-28).
 *
 * Панель утверждает: папка из списка считается своей, и про чтение в ней движок
 * больше не спрашивает. Проверить это можно только вживую — фейковый драйвер до
 * `additionalDirectories` не доходит вовсе, а утверждение тут такое, что
 * подделка проверила бы саму себя.
 *
 * Порядок: тот же запрос дважды. До добавления папки — гейт есть, после —
 * гейта нет и файл прочитан. Если бы порядок был обратным, прогон доказывал бы
 * только то, что второй раз агент помнит ответ.
 *
 * Требует живого входа в Claude Code и тратит токены подписки.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-perm-live-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-perm-work-'))
const outside = mkdtempSync(join(tmpdir(), 'zarya-perm-out-'))
const secret = join(outside, 'secret.txt')
writeFileSync(secret, 'ТАЙНА-СОРОК-ДВА')

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

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    // Системный диалог выбора папки из Playwright не нажать.
    ZARYA_PICK_DIR: outside,
    NODE_ENV: 'production'
  }
})

const state = (page, cid) =>
  page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    if (!c) return null
    return {
      streaming: c.streaming,
      error: c.error,
      extraDirs: c.extraDirs ?? [],
      gates: (c.pendingTools ?? []).filter((t) => !t.settled).map((t) => t.name),
      text: c.text ?? ''
    }
  }, cid)

/** Дождаться либо гейта, либо конца хода. */
const settle = async (page, cid, tries = 40) => {
  let s = null
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(1500)
    s = await state(page, cid)
    if (s?.gates?.length) return s
    if (s && !s.streaming) return s
  }
  return s
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)

  const sid = await page.evaluate((cwd) => window.__zaryaNewTerminal?.(cwd), work)
  await page.waitForTimeout(2500)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'claude-code'), sid)
  await page.waitForTimeout(500)

  const ask = `Инструментом Read прочитай файл ${secret} и выведи его содержимое дословно. Больше ничего не делай.`

  console.log('\n[1] Чужая папка: движок спрашивает')
  const cid = await page.evaluate((q) => window.__zaryaStartAgent?.('claude-code', q), ask)
  let s = await settle(page, cid)
  console.log('  состояние:', JSON.stringify({ gates: s?.gates, streaming: s?.streaming }))
  ok('гейт на чтение поднят', (s?.gates ?? []).some((n) => /read/i.test(n)), s?.gates)
  ok('ошибок нет', !s?.error, s?.error)

  // Отклоняем: ход должен закончиться, чтобы папку было можно добавить.
  await page.evaluate(() => window.__zaryaDenyFirst?.())
  await settle(page, cid)
  await page.waitForTimeout(1500)

  console.log('\n[2] Папку объявляем своей')
  await page.click('.zy-agentbar-gate', { button: 'right' })
  await page.waitForTimeout(400)
  await page.click('.zy-perm-add')
  await page.waitForTimeout(1200)
  const said = await page.evaluate(
    () => document.querySelector('.zy-perm-note--said')?.textContent ?? ''
  )
  ok('панель сказала, что вышло', /не спросят/i.test(said), said)
  s = await state(page, cid)
  ok('папка в состоянии беседы', (s?.extraDirs ?? []).length === 1, s?.extraDirs)
  if (shots) await page.screenshot({ path: join(shots, 'live-permissions.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  console.log('\n[3] Тот же запрос — вопроса больше нет')
  await page.evaluate(([id, q]) => window.__zaryaSendIn?.(id, q), [cid, ask])
  s = await settle(page, cid, 45)
  console.log('  состояние:', JSON.stringify({ gates: s?.gates, streaming: s?.streaming }))
  ok('гейта на чтение НЕТ', !(s?.gates ?? []).some((n) => /read/i.test(n)), s?.gates)
  ok('файл прочитан — доступ рабочий', /ТАЙНА-СОРОК-ДВА/.test(s?.text ?? ''), (s?.text ?? '').slice(-200))
  ok('ошибок нет', !s?.error, s?.error)

  console.log(`\n[permissions-live] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
  for (const dir of [work, outside]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // временная папка не удалилась — не повод ронять прогон
    }
  }
}
process.exit(fail ? 1 : 0)
