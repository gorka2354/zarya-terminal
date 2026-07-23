/**
 * Full terminal QA (no Claude API): create/split/close terminals, run real
 * shell commands, verify command blocks form with correct exit codes + cwd +
 * output, sessions model, and restart-restore. Runs against out/ with shell
 * integration resources copied in (OSC 133 needs resources/shell-integration).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
// Copy shell-integration resources so blocks form under out/main (documented fix).
try { cpSync(join(root, 'resources'), join(root, 'out', 'main', 'resources'), { recursive: true }) } catch {}
const userData = mkdtempSync(join(tmpdir(), 'zarya-qat-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }
const launch = () => electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })

const dumpS = (page) => page.evaluate(() => window.__zaryaDumpSessions?.())
const dumpB = (page, sid) => page.evaluate((s) => window.__zaryaDumpBlocks?.(s), sid)
async function waitBlock(page, sid, match, ms = 20000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(700)
    const blocks = (await dumpB(page, sid)) || []
    const b = blocks.find((x) => match(x))
    if (b) return b
  }
  return null
}

const errors = []
try {
  let app = await launch()
  let page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // ---- 1. Boot session ----
  console.log('\n[1] Стартовая сессия')
  let s = await dumpS(page)
  ok('на старте есть активная сессия', !!s?.activeSessionId, s)
  const boot = s.activeSessionId

  // ---- 2. Run a shell command → block with exit 0 + output ----
  console.log('\n[2] Команда → блок с exit 0 + вывод')
  await page.evaluate((sid) => window.__zaryaRunShell?.('cmd /c echo zarya-marker-42', sid), boot)
  let b = await waitBlock(page, boot, (x) => (/zarya-marker-42/.test(x.command) || /zarya-marker-42/.test(x.output)) && x.exitCode !== undefined)
  ok('блок сформировался', !!b, b)
  ok('вывод команды захвачен', b && /zarya-marker-42/.test(b.output), b?.output)
  ok('exit-код успешной команды реально захвачен = 0', b && b.exitCode === 0, b?.exitCode)

  // ---- 3. Failing external command → non-zero exit ----
  console.log('\n[3] Внешняя команда с кодом 7 → exit 7')
  await page.evaluate((sid) => window.__zaryaRunShell?.('cmd /c exit 7', sid), boot)
  b = await waitBlock(page, boot, (x) => /cmd \/c exit 7/.test(x.command) && x.exitCode !== undefined)
  ok('exit-код внешней команды = 7', b && b.exitCode === 7, b?.exitCode)

  // ---- 4. Create more terminals ----
  console.log('\n[4] Создание доп. терминалов')
  const t2 = await page.evaluate(() => window.__zaryaNewTerminal?.())
  await page.waitForTimeout(1500)
  const t3 = await page.evaluate((cwd) => window.__zaryaNewTerminal?.(cwd), root)
  await page.waitForTimeout(1800)
  s = await dumpS(page)
  ok('минимум 3 сессии существуют', s.sessions.length >= 3, s.sessions.length)
  ok('новый терминал стал активным', s.activeSessionId === t3, { active: s.activeSessionId, t3 })

  // ---- 5. cwd tracking in the folder-scoped terminal ----
  console.log('\n[5] Отслеживание cwd в терминале, открытом в папке')
  await page.evaluate((sid) => window.__zaryaRunShell?.('cmd /c echo cwdcheck', sid), t3)
  b = await waitBlock(page, t3, (x) => /cwdcheck/.test(x.command) || /cwdcheck/.test(x.output))
  ok('блок терминала-в-папке имеет cwd', !!(b && b.cwd), b?.cwd)
  ok('cwd указывает на папку проекта', b && /zarya-terminal/i.test(b.cwd || ''), b?.cwd)

  // ---- 6. Split the active terminal ----
  console.log('\n[6] Сплит активного терминала')
  const beforeLeaves = (await dumpS(page)).tabs.reduce((n, t) => n + t.leaves.length, 0)
  await page.evaluate(() => window.__zaryaSplitActive?.('row'))
  await page.waitForTimeout(1800)
  s = await dumpS(page)
  const afterLeaves = s.tabs.reduce((n, t) => n + t.leaves.length, 0)
  ok('сплит добавил панель (leaf)', afterLeaves === beforeLeaves + 1, { beforeLeaves, afterLeaves })

  // ---- 7. Close a session ----
  console.log('\n[7] Закрытие сессии')
  const beforeCount = (await dumpS(page)).sessions.length
  await page.evaluate((sid) => window.__zaryaCloseSession?.(sid), t2)
  await page.waitForTimeout(1500)
  const afterCount = (await dumpS(page)).sessions.length
  ok('закрытие убрало сессию', afterCount === beforeCount - 1, { beforeCount, afterCount })

  // ---- 8. Persist + restart-restore ----
  console.log('\n[8] Персист + рестарт → восстановление')
  await page.evaluate(() => window.__zaryaPersistAll?.())
  await page.waitForTimeout(1500)
  const pre = await dumpS(page)
  const preIds = pre.sessions.map((x) => x.id)
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)
  s = await dumpS(page)
  const afterIds = s.sessions.map((x) => x.id)
  // A fresh empty boot would mint BRAND-NEW ids; a real restore preserves them
  // (idMap.set(sid,sid)). Overlap proves restore, not a vacuous count>=1.
  const overlap = afterIds.filter((id) => preIds.includes(id))
  ok('восстановлены ИМЕННО прежние сессии (совпали id)', overlap.length >= 1, { preIds, afterIds })
  ok('число восстановленных совпадает с сохранённым', s.sessions.length === pre.sessions.length, { pre: pre.sessions.length, after: s.sessions.length })
  ok('активная сессия есть после рестарта', !!s.activeSessionId, s.activeSessionId)

  console.log('\n[9] Ошибки консоли')
  const real = errors.filter((e) => !/DevTools|Autofill|source map|font|Electron Security/i.test(e))
  ok('нет ошибок консоли', real.length === 0, real.slice(0, 4))

  console.log(`\n[qa-terminals] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
  await app.close()
} finally {
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
