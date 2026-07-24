/**
 * AcpDriver harness — drives the REAL AcpDriver (as 'gemini') against a mock ACP
 * agent speaking the real ndjson JSON-RPC 2.0 wire. Proves the driver end to end
 * through the generic agent stack (no Gemini install needed).
 *
 * Covers (extended through Ф3-Ф5): (1) capabilities + probe; (2) init + chunk
 * accumulation + result; plus killAll teardown. Approval (3,4), fs-proxy (7),
 * resume (5), interrupt (6), crash/recovery (9,10) land in later phases.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-acp-'))
const mockPath = join(root, 'scripts', 'mock-acp-agent.mjs')
const pidFile = join(userData, 'acp.pid')
const approvalLog = join(userData, 'approvals.jsonl')
const fsLog = join(userData, 'fs.jsonl')
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
    ZARYA_GEMINI_BIN: process.execPath,
    ZARYA_GEMINI_ARGS: JSON.stringify([mockPath]),
    ZARYA_ACP_PID_FILE: pidFile,
    ZARYA_ACP_APPROVAL_LOG: approvalLog,
    ZARYA_ACP_FS_LOG: fsLog
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
  console.log('\n[1] AcpDriver (gemini) зарегистрирован, прошёл probe, профиль верный')
  const caps = await page.evaluate(async () => window.zarya.agent.capabilities())
  ok('gemini зарегистрирован и виден (probe ok)', !!caps.gemini, Object.keys(caps))
  // codex is hidden here (its `codex --version` probe fails — not installed);
  // claude-code has no probe, so it's always present.
  ok('claude-code рядом в реестре', !!caps['claude-code'])
  ok('gemini.structuredQuestions=false', caps.gemini?.structuredQuestions === false)
  ok('gemini.effort=false (ACP без тяги)', caps.gemini?.effort === false)
  ok('gemini.usage=false', caps.gemini?.usage === false)
  ok('gemini.models=false (ACP не даёт live-список/переключение)', caps.gemini?.models === false)
  ok('gemini.bypass/resume=true', !!(caps.gemini?.bypass && caps.gemini?.resumableSessions))

  // ---- 2. init + streamed chunks accumulated into one assistant + result ----
  console.log('\n[2] Полный ход: initialize → session/new → session/prompt → chunks → result')
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'привет'))
  const c = await waitDone(page, id)
  ok('беседа помечена engine=gemini', c?.engine === 'gemini', c?.engine)
  ok('init выдал sessionId (session/new)', /^sess_/.test(c?.sessionId || ''), c?.sessionId)
  ok('чанки собраны в ОДИН ответ ассистента', /gemini mock: привет/.test(c?.text || ''), c?.text)
  ok('ровно один пузырь ассистента (chunks не размножились)', (c?.text || '').split('gemini mock').length === 2, c?.text)
  ok('ход завершился (stopReason → result)', !!(c && !c.streaming && !c.error))

  // ---- 3. request_permission ACCEPT (optionId echoed by kind) ----
  console.log('\n[3] session/request_permission: гейт → approve → selected allow-optionId ушёл')
  const aid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'run a tool please'))
  ok('gemini поднял permission-гейт', await waitGate(page, aid))
  await page.evaluate(() => window.__zaryaApproveFirst?.())
  const ac = await waitDone(page, aid)
  ok('ход завершился после approve', !!(ac && !ac.streaming && !ac.error))
  ok('гейт снят (pendingTools пусты)', (ac?.pendingTools || []).length === 0)
  ok('outcome selected + allow-optionId доставлен агенту', /"outcome":"selected"/.test(readApprovals()) && /allow-once/.test(readApprovals()), readApprovals().slice(-160))

  // ---- 4. request_permission DENY (reject-optionId) ----
  console.log('\n[4] session/request_permission: гейт → deny → selected reject-optionId ушёл')
  const did = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'run a tool please'))
  ok('gemini поднял permission-гейт (2-й раз)', await waitGate(page, did))
  await page.evaluate(() => window.__zaryaDenyFirst?.())
  const dc = await waitDone(page, did)
  ok('ход завершился после deny', !!(dc && !dc.streaming))
  ok('reject-optionId доставлен агенту', /reject-once/.test(readApprovals()), readApprovals().slice(-160))

  // ---- 5. resume (session/load) ----
  console.log('\n[5] Resume: беседа с прежним sessionId → session/load (тот же sessionId)')
  const rid = await page.evaluate(() =>
    window.__zaryaResumeAgent?.('gemini', 'sess_resumed_9', 'после рестарта')
  )
  const rc = await waitDone(page, rid)
  ok('resume дал ТОТ ЖЕ sessionId (session/load, не new)', rc?.sessionId === 'sess_resumed_9', rc?.sessionId)
  ok('ассистент ответил после resume', /gemini mock: после рестарта/.test(rc?.text || ''), rc?.text)

  // ---- 6. interrupt (session/cancel) ----
  console.log('\n[6] Interrupt: активный ход → abort → session/cancel → stopReason:cancelled')
  const iid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'slow task'))
  await page.waitForTimeout(500)
  const mid = await convById(page, iid)
  ok('ход идёт (streaming) до прерывания', mid?.streaming === true, { streaming: mid?.streaming })
  await page.evaluate(() => window.__zaryaAbort?.())
  const ic = await waitDone(page, iid)
  ok('ход завершился после interrupt', !!(ic && !ic.streaming))

  // ---- 7. fs-proxy: write in cwd OK, traversal outside cwd REJECTED (security) ----
  console.log('\n[7] fs-proxy: запись в cwd выполняется, traversal вне cwd отклонён (граница безопасности)')
  const wid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'writefile please'))
  await waitDone(page, wid)
  await page.waitForTimeout(300)
  const fslog = existsSync(fsLog) ? readFileSync(fsLog, 'utf8') : ''
  ok('fs/write внутри cwd выполнен', /"kind":"write","ok":true/.test(fslog), fslog)
  ok('fs/write traversal (/etc) ОТКЛОНЁН драйвером', !/traversal-unexpected-ok/.test(fslog), fslog)

  // ---- 8. follow-up (same session) ----
  console.log('\n[8] Follow-up: второй ход в той же беседе (session/prompt на том же sessionId)')
  const fid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'первый'))
  await waitDone(page, fid)
  const firstSession = (await convById(page, fid))?.sessionId
  await page.evaluate(() => window.__zaryaFollowUp?.('второй ход'))
  await page.waitForTimeout(700)
  const fc = await convById(page, fid)
  ok('follow-up остался в той же сессии', !!firstSession && fc?.sessionId === firstSession, { first: firstSession, now: fc?.sessionId })
  ok('второй ответ пришёл в ту же беседу', (fc?.text || '').includes('второй ход'), fc?.text)

  // ---- 9. agent dies mid-turn → error, not a hang ----
  console.log('\n[9] ACP-агент умирает посреди хода → беседа получает error (не спиннер)')
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'crash now'))
  let crashErr = null
  const cdl = Date.now() + 10000
  while (Date.now() < cdl) {
    await page.waitForTimeout(150)
    const cc = await convById(page, cid)
    if (cc && !cc.streaming && cc.error) {
      crashErr = cc.error
      break
    }
  }
  ok('беседа получила error при смерти агента', !!crashErr, crashErr)

  // ---- 10. recovery after crash ----
  console.log('\n[10] Восстановление: новый ход после краха переспавнивает агента')
  const nid = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'снова живой'))
  const nc = await waitDone(page, nid)
  ok('после краха новый ход отработал', /gemini mock: снова живой/.test(nc?.text || ''), { err: nc?.error, text: nc?.text })

  console.log(`\n[qa-acp-driver] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
  await new Promise((r) => setTimeout(r, 700))
  let dead = false
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf8'), 10)
    if (pid > 0) {
      try {
        process.kill(pid, 0)
        dead = false
      } catch {
        dead = true
      }
    }
  }
  if (dead) {
    pass++
    console.log('  ✓ ACP-агент убит при выходе (killAll)')
  } else {
    fail++
    console.log('  ✗ ACP teardown — процесс жив или не стартовал (pidFile=' + existsSync(pidFile) + ')')
  }
  console.log(`\n[qa-acp-driver FINAL] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
