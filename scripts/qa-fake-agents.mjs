/**
 * Ф5 — proves the AgentDriver abstraction works for engines OTHER than Claude.
 * Two scripted FakeAgentDrivers (codex, gemini) with DISTINCT capability
 * profiles are registered under ZARYA_FAKE_AGENT. Asserts, end to end:
 *  1. capabilities() exposes both fake engines with their declared profiles, and
 *     the renderer mirrors them into uiStore.agentCaps;
 *  2. two engines stream concurrently into ONE terminal and their events NEVER
 *     cross (codex text never lands in the gemini conversation, and vice-versa);
 *  3. capability-gating: a fake with usage:false does NOT clobber claudeStatus
 *     (the Claude-only fuel gauge), and structuredQuestions gates the question
 *     path (gemini=true surfaces one; codex=false surfaces none);
 *  4. block-switch-while-busy: the mode chip refuses to cycle away from a busy
 *     engine, then cycles again once the turn frees;
 *  5. teardown: quitting calls killAll on EVERY registered driver.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-fake-'))
const killLog = join(userData, 'killlog.txt')
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
    ZARYA_FAKE_AGENT: '1',
    ZARYA_FAKE_KILL_LOG: killLog,
    NODE_ENV: 'production'
  }
})

const convById = (page, id) => page.evaluate((i) => window.__zaryaConvById?.(i), id)
async function waitDone(page, id, ms = 15000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(200)
    const c = await convById(page, id)
    if (c && !c.streaming && c.text) return c
  }
  return convById(page, id)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  // ---- 1. capabilities registered with the declared profiles ----
  console.log('\n[1] Возможности fake-движков зарегистрированы и проброшены в renderer')
  const caps = await page.evaluate(async () => window.zarya.agent.capabilities())
  ok('codex зарегистрирован', !!caps.codex, Object.keys(caps))
  ok('gemini зарегистрирован', !!caps.gemini)
  ok('claude-code остался в реестре', !!caps['claude-code'])
  ok('codex.usage=false (нет топлива)', caps.codex?.usage === false)
  ok('codex.structuredQuestions=false', caps.codex?.structuredQuestions === false)
  ok('gemini.structuredQuestions=true (есть ask_user)', caps.gemini?.structuredQuestions === true)
  ok('gemini.effort=false (нет тяги)', caps.gemini?.effort === false)
  const uiCaps = await page.evaluate(() => window.__zaryaAgentCaps?.())
  ok('renderer.agentCaps отражает codex+gemini', !!uiCaps?.codex && !!uiCaps?.gemini, Object.keys(uiCaps || {}))

  // ---- 2. concurrent streaming into ONE terminal; events never cross ----
  console.log('\n[2] Два движка стримят в ОДИН терминал одновременно — события не путаются')
  const [idC, idG] = await page.evaluate(() => [
    window.__zaryaStartAgent?.('codex', 'привет кодекс'),
    window.__zaryaStartAgent?.('gemini', 'привет джемини')
  ])
  const cC = await waitDone(page, idC)
  const cG = await waitDone(page, idG)
  ok('codex-беседа получила свой ответ', /fake codex: привет кодекс/.test(cC?.text || ''), cC?.text)
  ok('codex-беседа НЕ содержит текст gemini', !/gemini/i.test(cC?.text || ''), cC?.text)
  ok('gemini-беседа получила свой ответ', /fake gemini: привет джемини/.test(cG?.text || ''), cG?.text)
  ok('gemini-беседа НЕ содержит текст codex', !/codex/i.test(cG?.text || ''), cG?.text)
  ok('движки помечены верно', cC?.engine === 'codex' && cG?.engine === 'gemini', { c: cC?.engine, g: cG?.engine })

  // ---- 3. capability-gating ----
  console.log('\n[3] Гейтинг: fake usage:false не затирает claudeStatus; structuredQuestions гейтит вопрос')
  const cs = await page.evaluate(() => window.__zaryaClaudeStatus?.())
  ok('claudeStatus.model НЕ codex/gemini (статус Claude нетронут)', cs?.model !== 'codex-model' && cs?.model !== 'gemini-model', cs?.model)
  ok('claudeStatus.usage не от fake', !cs?.usage || cs?.usage?.subscriptionType !== 'fake', cs?.usage)

  const idGq = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'ask me a color'))
  let sawQ = false
  {
    const dl = Date.now() + 8000
    while (Date.now() < dl) {
      await page.waitForTimeout(200)
      const c = await convById(page, idGq)
      if ((c?.pendingTools || []).some((t) => t.kind === 'question')) {
        sawQ = true
        break
      }
      if (c && !c.streaming) break
    }
  }
  ok('gemini (structuredQuestions=true) поднял вопрос', sawQ)
  const idCq = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'ask me a color'))
  const cCq = await waitDone(page, idCq)
  ok('codex (structuredQuestions=false) вопрос НЕ поднял', !(cCq?.pendingTools || []).some((t) => t.kind === 'question'), cCq?.pendingTools)

  // ---- 4. block-switch-while-busy ----
  console.log('\n[4] Блокировка переключения пока движок занят (гейт не должен осиротеть)')
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'codex' }))
  const idBusy = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  await page.waitForTimeout(900) // fake gates at 400ms; streaming stays true at a gate
  const busy = await convById(page, idBusy)
  ok('codex-беседа занята (streaming на гейте)', busy?.streaming === true, { streaming: busy?.streaming, pt: busy?.pendingTools })
  await page.waitForSelector('.zy-agentbar-mode', { timeout: 3000 }).catch(() => {})
  const before = await page.evaluate(() => window.__zaryaBarMode?.())
  await page.click('.zy-agentbar-mode').catch(() => {})
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => window.__zaryaBarMode?.())
  ok('чип НЕ переключился пока движок занят', before === 'codex' && after === 'codex', { before, after })
  // free the gate → chip works again
  await page.evaluate(() => window.__zaryaApproveFirst?.())
  await waitDone(page, idBusy)
  await page.click('.zy-agentbar-mode').catch(() => {})
  await page.waitForTimeout(300)
  const freed = await page.evaluate(() => window.__zaryaBarMode?.())
  ok('после освобождения чип снова переключается', freed !== 'codex', freed)

  console.log(`\n[qa-fake-agents] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
  // ---- 5. teardown: killAll called for every registered driver on quit ----
  await new Promise((r) => setTimeout(r, 500))
  const log = existsSync(killLog) ? readFileSync(killLog, 'utf8') : ''
  const killed = new Set(
    log
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  if (killed.has('codex') && killed.has('gemini')) {
    pass++
    console.log('  ✓ killAll вызван для codex и gemini при выходе')
  } else {
    fail++
    console.log('  ✗ killAll teardown → ' + JSON.stringify([...killed]))
  }
  console.log(`\n[qa-fake-agents FINAL] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
