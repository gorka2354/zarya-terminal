/**
 * CodexDriver harness — drives the REAL CodexDriver against a mock app-server
 * that speaks the real wire protocol. Proves the driver end to end through the
 * generic agent stack (no Codex install needed).
 *
 * Covers (Ф2-Ф5): (1) capabilities + probe gating; (2) init + streamed
 * assistant + result; (3) command-approval accept; (4) deny; (5) resume;
 * (6) interrupt; (7) model/list catalog; (8) follow-up on the same thread;
 * (9) app-server death mid-turn → error not a hang; (10) recovery after crash;
 * plus killAll teardown. JSON-RPC framing + DoS-cap edge cases are unit-tested
 * separately (tests/codexRpc.test.ts).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-codex-'))
const mockPath = join(root, 'scripts', 'mock-codex-app-server.mjs')
const pidFile = join(userData, 'codex.pid')
const approvalLog = join(userData, 'approvals.jsonl')
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
    ZARYA_USER_DATA: userData,
    NODE_ENV: 'production',
    ZARYA_CODEX_BIN: process.execPath,
    ZARYA_CODEX_ARGS: JSON.stringify([mockPath]),
    ZARYA_CODEX_PID_FILE: pidFile,
    ZARYA_CODEX_APPROVAL_LOG: approvalLog
  }
})

const convById = (page, id) => page.evaluate((i) => window.__zaryaConvById?.(i), id)
async function waitDone(page, id, ms = 15000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(150)
    const c = await convById(page, id)
    if (c && !c.streaming && (c.text || c.error)) return c
  }
  return convById(page, id)
}
/** Wait until the conversation has an unsettled pending tool (an approval gate). */
async function waitGate(page, id, ms = 8000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(120)
    const c = await convById(page, id)
    if ((c?.pendingTools || []).some((t) => !t.settled)) return true
    if (c && !c.streaming) return false
  }
  return false
}
const readApprovals = () => (existsSync(approvalLog) ? readFileSync(approvalLog, 'utf8') : '')

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  // ---- 1. capabilities + probe gating ----
  console.log('\n[1] CodexDriver зарегистрирован, прошёл probe, профиль верный')
  const caps = await page.evaluate(async () => window.zarya.agent.capabilities())
  ok('codex зарегистрирован и виден (probe ok)', !!caps.codex, Object.keys(caps))
  ok('claude-code рядом в реестре', !!caps['claude-code'])
  ok('codex.usage=false (нет топлива)', caps.codex?.usage === false)
  ok('codex.structuredQuestions=false (нет ask_user)', caps.codex?.structuredQuestions === false)
  ok(
    'codex.effort/models/bypass/resume=true',
    !!(
      caps.codex?.effort &&
      caps.codex?.models &&
      caps.codex?.bypass &&
      caps.codex?.resumableSessions
    ),
    caps.codex
  )

  // ---- 2. init + streamed assistant + result ----
  console.log('\n[2] Полный ход: handshake → thread/start → turn/start → assistant → result')
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  const c = await waitDone(page, id)
  ok('беседа помечена engine=codex', c?.engine === 'codex', c?.engine)
  ok('init выдал threadId (result.thread.id)', /^thr_/.test(c?.sessionId || ''), c?.sessionId)
  ok('ассистент ответил из codex (item/completed agentMessage → item.text)', /codex mock: привет/.test(c?.text || ''), c?.text)
  ok('ход завершился без ошибки (turn/completed → result)', !!(c && !c.streaming && !c.error))

  // ---- 3. command-approval ACCEPT ----
  console.log('\n[3] Command-approval: гейт → approve → decision:accept ушёл серверу, команда выполнилась')
  const aid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  ok('codex поднял approval-гейт (server-request → permission)', await waitGate(page, aid))
  await page.evaluate(() => window.__zaryaApproveFirst?.())
  const ac = await waitDone(page, aid)
  ok('ход завершился после approve', !!(ac && !ac.streaming && !ac.error))
  ok('гейт снят (pendingTools пусты)', (ac?.pendingTools || []).length === 0)
  ok('decision:accept доставлен app-server-у', /"decision":"accept"/.test(readApprovals()), readApprovals().slice(-120))

  // ---- 4. command-approval DENY ----
  console.log('\n[4] Command-approval: гейт → deny → decision:decline ушёл серверу')
  const did = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  ok('codex поднял approval-гейт (2-й раз)', await waitGate(page, did))
  await page.evaluate(() => window.__zaryaDenyFirst?.())
  const dc = await waitDone(page, did)
  ok('ход завершился после deny', !!(dc && !dc.streaming))
  ok('decision:decline доставлен app-server-у', /"decision":"decline"/.test(readApprovals()), readApprovals().slice(-120))

  // ---- 5. resume ----
  console.log('\n[5] Resume: беседа с прежним sessionId → thread/resume (тот же тред, не новый)')
  const rid = await page.evaluate(() =>
    window.__zaryaResumeAgent?.('codex', 'thr_resumed_99', 'после рестарта')
  )
  const rc = await waitDone(page, rid)
  ok('resume дал ТОТ ЖЕ threadId (thread/resume, не start)', rc?.sessionId === 'thr_resumed_99', rc?.sessionId)
  ok('ассистент ответил после resume', /codex mock: после рестарта/.test(rc?.text || ''), rc?.text)

  // ---- 6. interrupt ----
  console.log('\n[6] Interrupt: активный ход → abort → turn/interrupt → turn/completed(interrupted)')
  const iid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'slow task'))
  await page.waitForTimeout(500) // fake streams the assistant but never completes (slow)
  const mid = await convById(page, iid)
  ok('ход идёт (streaming) до прерывания', mid?.streaming === true, {
    streaming: mid?.streaming,
    text: mid?.text
  })
  await page.evaluate(() => window.__zaryaAbort?.())
  const ic = await waitDone(page, iid)
  ok('ход завершился после interrupt', !!(ic && !ic.streaming))

  // ---- 7. model/list ----
  console.log('\n[7] model/list: драйвер тянет каталог, маппит data→AgentModelInfo, прячет hidden')
  const models = await page.evaluate(() => window.__zaryaListModels?.('codex'))
  ok('model/list вернул модели', Array.isArray(models) && models.length >= 2, models)
  ok('hidden-модель отфильтрована', !(models || []).some((m) => m.value === 'internal-hidden'))
  ok(
    'модель имеет value+displayName (id→value)',
    (models || [])[0]?.value === 'gpt-5.1-codex' && !!(models || [])[0]?.displayName,
    (models || [])[0]
  )

  // ---- 8. follow-up (same thread) ----
  console.log('\n[8] Follow-up: второй ход в той же беседе (turn/start на том же threadId)')
  const fid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'первый'))
  await waitDone(page, fid)
  const firstThread = (await convById(page, fid))?.sessionId
  await page.evaluate(() => window.__zaryaFollowUp?.('второй ход'))
  await page.waitForTimeout(700)
  const fc = await convById(page, fid)
  ok('follow-up остался в том же треде', !!firstThread && fc?.sessionId === firstThread, {
    first: firstThread,
    now: fc?.sessionId
  })
  ok('второй ответ пришёл в ту же беседу', (fc?.text || '').includes('второй ход'), fc?.text)

  // ---- 9. app-server dies mid-turn → error, not an eternal spinner (P1) ----
  console.log('\n[9] App-server умирает посреди хода → беседа получает error (P1, не вечный спиннер)')
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'crash now'))
  let crashErr = null
  const cdl = Date.now() + 10000
  while (Date.now() < cdl) {
    await page.waitForTimeout(150)
    const c = await convById(page, cid)
    if (c && !c.streaming && c.error) {
      crashErr = c.error
      break
    }
  }
  ok('беседа получила error при смерти app-server (не зависла)', !!crashErr, crashErr)

  // ---- 10. recovery: a fresh turn re-spawns the server and works (P1/P2b) ----
  console.log('\n[10] Восстановление: новый ход после краха переспавнивает сервер и работает')
  const nid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'снова живой'))
  const nc = await waitDone(page, nid)
  ok('после краха новый ход отработал (сервер переспавнен)', /codex mock: снова живой/.test(nc?.text || ''), {
    err: nc?.error,
    text: nc?.text
  })

  console.log(`\n[qa-codex-driver] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
  // ---- 7. killAll teardown: the app-server child must be gone after quit ----
  await new Promise((r) => setTimeout(r, 700))
  let dead = false
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf8'), 10)
    if (pid > 0) {
      try {
        process.kill(pid, 0)
        dead = false // still alive
      } catch {
        dead = true // ESRCH — process gone
      }
    }
  }
  if (dead) {
    pass++
    console.log('  ✓ app-server убит при выходе (killAll)')
  } else {
    fail++
    console.log('  ✗ app-server teardown — процесс жив или не стартовал (pidFile=' + existsSync(pidFile) + ')')
  }
  console.log(`\n[qa-codex-driver FINAL] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
