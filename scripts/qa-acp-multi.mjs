/**
 * Proves the ONE AcpDriver class is truly engine-parameterized: Gemini, Kimi and
 * Qwen all run through it against the same mock ACP agent, differing only by
 * engine id / binary. (Gemini's full surface is covered by qa-acp-driver; here
 * the focus is that kimi + qwen — the inc-12 engines — work identically.)
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-acpm-'))
const mockPath = join(root, 'scripts', 'mock-acp-agent.mjs')
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

const mockBin = JSON.stringify([mockPath])
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ZARYA_USER_DATA: userData,
    NODE_ENV: 'production',
    ZARYA_GEMINI_BIN: process.execPath,
    ZARYA_GEMINI_ARGS: mockBin,
    ZARYA_KIMI_BIN: process.execPath,
    ZARYA_KIMI_ARGS: mockBin,
    ZARYA_QWEN_BIN: process.execPath,
    ZARYA_QWEN_ARGS: mockBin,
    ZARYA_ACP_APPROVAL_LOG: approvalLog
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

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  // ---- 1. all three ACP engines registered + probed via the same class ----
  console.log('\n[1] Все три ACP-движка (gemini/kimi/qwen) в реестре через ОДИН AcpDriver')
  const caps = await page.evaluate(async () => window.zarya.agent.capabilities())
  ok('gemini доступен', !!caps.gemini)
  ok('kimi доступен', !!caps.kimi, Object.keys(caps))
  ok('qwen доступен', !!caps.qwen)
  ok('kimi/qwen профиль как ACP (structuredQuestions:false, effort:false)', caps.kimi?.structuredQuestions === false && caps.qwen?.effort === false)

  // ---- 2. kimi: full turn ----
  console.log('\n[2] Kimi (kimi acp): init → стриминг → result')
  const kid = await page.evaluate(() => window.__zaryaStartAgent?.('kimi', 'привет кими'))
  const kc = await waitDone(page, kid)
  ok('kimi беседа engine=kimi', kc?.engine === 'kimi', kc?.engine)
  ok('kimi init sessionId', /^sess_/.test(kc?.sessionId || ''), kc?.sessionId)
  ok('kimi ассистент ответил', /gemini mock: привет кими/.test(kc?.text || ''), kc?.text)

  // ---- 3. qwen: full turn ----
  console.log('\n[3] Qwen (qwen --acp): init → стриминг → result')
  const qid = await page.evaluate(() => window.__zaryaStartAgent?.('qwen', 'привет цвен'))
  const qc = await waitDone(page, qid)
  ok('qwen беседа engine=qwen', qc?.engine === 'qwen', qc?.engine)
  ok('qwen init sessionId', /^sess_/.test(qc?.sessionId || ''), qc?.sessionId)
  ok('qwen ассистент ответил', /gemini mock: привет цвен/.test(qc?.text || ''), qc?.text)

  // ---- 4. kimi permission gate works through the shared driver ----
  console.log('\n[4] Kimi: permission-гейт через тот же AcpDriver → approve')
  const aid = await page.evaluate(() => window.__zaryaStartAgent?.('kimi', 'run a tool please'))
  ok('kimi поднял permission-гейт', await waitGate(page, aid))
  await page.evaluate(() => window.__zaryaApproveFirst?.())
  const ac = await waitDone(page, aid)
  ok('kimi ход завершился после approve', !!(ac && !ac.streaming && !ac.error))
  const approvals = existsSync(approvalLog) ? readFileSync(approvalLog, 'utf8') : ''
  ok('kimi allow-optionId доставлен агенту', /allow-once/.test(approvals), approvals.slice(-120))

  console.log(`\n[qa-acp-multi] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
