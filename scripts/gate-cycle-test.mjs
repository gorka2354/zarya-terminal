/**
 * Цикл режимов допуска: Shift+Tab и замок (inc-25).
 *
 * Ступень «правки без спроса» — та, ради которой человек в консоли жмёт
 * Shift+Tab чаще всего. Проверяем на живом окне: цикл идёт по кругу в одну
 * сторону, чип называет состояние, а решение доезжает до беседы — и, главное,
 * ступень НЕ равна автопилоту.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-gate-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    NODE_ENV: 'production'
  }
})

/** Состояние замка так, как его видно человеку. */
const chip = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.zy-agentbar-bypass')
    if (!el) return null
    return {
      edits: el.className.includes('--edits'),
      auto: el.className.includes('--on'),
      title: el.getAttribute('title') || ''
    }
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(500)

  console.log('\n[1] Начинаем со «спрашивать всё»')
  const s0 = await chip(page)
  ok('замок есть', !!s0, s0)
  ok('не автопилот', s0?.auto === false, s0)
  ok('не ступень правок', s0?.edits === false, s0)

  console.log('\n[2] Shift+Tab включает «правки без спроса», а не автопилот')
  await page.click('.zy-agentbar-input')
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(600)
  const s1 = await chip(page)
  ok('ступень включилась', s1?.edits === true, s1)
  ok('автопилот НЕ включился', s1?.auto === false, s1)
  ok('подпись объясняет разницу', /команд|command/i.test(s1?.title ?? ''), s1?.title)

  console.log('\n[3] Второй Shift+Tab — автопилот')
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(600)
  const s2 = await chip(page)
  ok('автопилот включился', s2?.auto === true, s2)
  ok('ступень снялась — состояние одно', s2?.edits === false, s2)

  console.log('\n[4] Третий Shift+Tab возвращает вопросы')
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(600)
  const s3 = await chip(page)
  ok('вопросы вернулись', s3?.auto === false && s3?.edits === false, s3)

  console.log('\n[5] Решение принадлежит панели и доезжает до беседы')
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2000)
  const conv = await page.evaluate(() => {
    const c = window.__zaryaDumpConv?.()
    return c ? { editsAuto: !!c.editsAuto, bypass: !!c.bypass } : null
  })
  ok('беседа завелась со ступенью', conv?.editsAuto === true, conv)
  ok('и без автопилота', conv?.bypass === false, conv)

  if (shots) await page.screenshot({ path: join(shots, 'gate-cycle.png') })
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  process.exit(fail ? 1 : 0)
}
