/**
 * Пол под автопилотом и «разрешить до конца сессии».
 *
 * Раньше выбор был из двух положений: подтверждать `git status` по сто раз за
 * день — или снять гейт целиком и получить `rm -rf` без вопроса. Люди выбирают
 * второе, потому что первое невыносимо, и это худший исход.
 *
 * Прогон проверяет, что появилась середина и что у неё есть дно:
 * — «до конца сессии» больше не спрашивает про ТУ ЖЕ команду;
 * — но про другую спрашивает, даже если начало совпадает;
 * — необратимое показывается всегда, даже при включённом автопилоте, и
 *   разрешить его «до конца сессии» нельзя вообще.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-floor-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

/** Ждём, пока в беседе появится нерешённый гейт (или не появится). */
const waitGate = async (page, convId, ms = 3000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const t = await page.evaluate(
      (id) => window.__zaryaConvById?.(id)?.pendingTools?.find((x) => !x.settled) ?? null,
      convId
    )
    if (t) return t
    await page.waitForTimeout(200)
  }
  return null
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(300)

  console.log('\n[1] У карточки три решения, а не два')
  const id1 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  ok('гейт встал', !!(await waitGate(page, id1)))
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-actions button')].map((b) => b.textContent.trim())
  )
  ok('есть «до конца сессии»', buttons.includes('ДО КОНЦА СЕССИИ'), buttons)
  ok('и обычные «выполнить»/«отклонить»', buttons.includes('ВЫПОЛНИТЬ') && buttons.includes('ОТКЛОНИТЬ'), buttons)

  console.log('\n[2] Разрешённое больше не спрашивают — но только его')
  const tool1 = await waitGate(page, id1)
  await page.evaluate(([c, t]) => window.__zaryaAllowForSession?.(c, t), [id1, tool1.id])
  await page.waitForTimeout(700)
  const rules = await page.evaluate((id) => window.__zaryaConvById?.(id)?.sessionAllows ?? [], id1)
  ok('правило записано дословно', rules.includes('Bash: echo fake'), rules)

  // Второй ход в ТОЙ ЖЕ беседе: правило — её свойство, и у новой беседы своих
  // правил нет, как и должно быть.
  await page.evaluate((id) => window.__zaryaSendIn?.(id, 'run a tool please'), id1)
  await page.waitForTimeout(2000)
  const still = await page.evaluate(
    (id) => window.__zaryaConvById?.(id)?.pendingTools?.filter((x) => !x.settled).length ?? 0,
    id1
  )
  ok('та же команда прошла без вопроса', still === 0, still)

  // А новая беседа спрашивает заново — «до конца сессии» не значит «навсегда».
  const idFresh = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  ok('в новой беседе спрашивают снова', !!(await waitGate(page, idFresh)))

  console.log('\n[3] Необратимое спрашивают всегда')
  // Автопилот включаем на самой беседе — он свойство беседы, а не панели.
  const convId = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(800)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), convId)
  await page.waitForTimeout(300)

  const id3 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  await page.waitForTimeout(1800)
  const quiet = await page.evaluate(
    (id) => window.__zaryaConvById?.(id)?.pendingTools?.filter((x) => !x.settled).length ?? 0,
    id3
  )
  ok('при автопилоте обычное не спрашивают', quiet === 0, quiet)

  const id4 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a danger tool'))
  const danger = await waitGate(page, id4)
  ok('а «rm -rf» — спрашивают', !!danger, danger)
  ok('и сказано, почему', !!danger?.irreversible, danger?.irreversible)
  ok('в подписи видна сама команда', (danger?.irreversible?.hit ?? '').includes('rm -rf'), danger?.irreversible)

  const dangerButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-actions button')].map((b) => b.textContent.trim())
  )
  ok(
    'разрешить его «до конца сессии» нельзя',
    !dangerButtons.includes('ДО КОНЦА СЕССИИ'),
    dangerButtons
  )
  const warn = await page.evaluate(() => document.querySelector('.zy-mf-tool-stop')?.textContent ?? '')
  ok('предупреждение на экране', warn.includes('не отменить'), warn.slice(0, 60))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временный профиль */
  }
}

console.log(`\n[gate-floor] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
