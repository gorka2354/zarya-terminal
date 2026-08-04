/**
 * Новые скиллы и MCP — без перезапуска сессии.
 *
 * Поставил MCP-сервер или скилл — агент просит перезапустить сессию, то есть
 * предлагает потерять разговор и начать сначала. Перезапуск при этом не нужен:
 * SDK умеет перечитать диск на живой сессии (reloadSkills/reloadPlugins).
 *
 * Прогон проверяет всю цепочку целиком и на НАСТОЯЩЕМ Claude Code:
 * — живая сессия действительно НЕ видит новый скилл (иначе проверять нечего);
 * — Заря замечает изменение на диске и предлагает подхватить;
 * — после «подхватить» скилл в списке, а сессия — та же самая.
 *
 * Нужен живой Claude Code, поэтому вне CI: `npm run qa:extras`.
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

const PROBE = 'zarya-extras-probe'
const skillDir = join(homedir(), '.claude', 'skills', PROBE)
const userData = mkdtempSync(join(tmpdir(), 'zarya-extras-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

const hasProbe = (list) => (list ?? []).some((c) => c.name.includes(PROBE))

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'claude-code'), sid)

  console.log('\n[1] Живая сессия и её список команд')
  const convId = await page.evaluate(
    (s) => window.__zaryaStartAgentIn?.('claude-code', 'ответь одним словом: тут', s),
    sid
  )
  await page.waitForTimeout(14000)
  const sessionBefore = await page.evaluate((c) => window.__zaryaConvById?.(c)?.sessionId, convId)
  ok('сессия Claude Code живая', !!sessionBefore, sessionBefore)

  const before = await page.evaluate(() => window.zarya.agent.listCommands('claude-code'))
  ok('команды пришли от движка', before.source === 'engine' && before.commands.length > 10, before.commands.length)
  ok('пробного скилла ещё нет', !hasProbe(before.commands))

  console.log('\n[2] Скилл кладётся на диск при работающей сессии')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${PROBE}\ndescription: Проба подхвата скилла без перезапуска сессии\n---\n\nНичего не делает.\n`
  )
  await page.waitForTimeout(1200)

  const stale = await page.evaluate(() => window.zarya.agent.listCommands('claude-code'))
  // Это и есть та боль, ради которой всё делается: сессия живёт со старым
  // списком, и агент в такой ситуации просит перезапуск.
  ok('живая сессия НЕ видит новый скилл сама', !hasProbe(stale.commands))

  await page.waitForTimeout(2500)
  ok('Заря заметила изменение на диске', (await page.locator('[data-extras-bar]').count()) === 1)

  console.log('\n[3] Подхват без перезапуска')
  const r = await page.evaluate(() => window.zarya.agent.reloadExtras('claude-code'))
  ok('перечитали успешно', r.ok === true, r)
  ok('скилл появился в списке', hasProbe(r.commands), (r.commands ?? []).length)
  ok('MCP-серверы посчитаны', Array.isArray(r.mcpServers), r.mcpServers?.length)
  ok('ошибок нет', r.errors === 0, r.errors)

  const sessionAfter = await page.evaluate((c) => window.__zaryaConvById?.(c)?.sessionId, convId)
  ok('сессия ТА ЖЕ — контекст не потерян', sessionAfter === sessionBefore, {
    sessionBefore,
    sessionAfter
  })
} finally {
  await app.close()
  try {
    rmSync(skillDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временные каталоги */
  }
}

console.log(`\n[extras] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
