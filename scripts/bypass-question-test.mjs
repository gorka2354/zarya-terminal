/**
 * Bypass redesign suite. Bypass is now an auto-allow INSIDE canUseTool (mode
 * stays 'default'), not permissionMode:'bypassPermissions'. Proves:
 *  1. bypass ON  → ordinary tool runs with no prompt;
 *  2. toggle OFF live (same session) → the next tool gates (asks);
 *  3. AskUserQuestion STILL surfaces the widget even with bypass ON (the fix —
 *     it must never be auto-answered);
 *  4. the SDK CAN_USE_TOOL_SHADOWED warning is GONE from the main-process stderr.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-bq-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '') } }

const CMD = 'Выполни ровно одну bash-команду: curl -s https://api.github.com/zen . Больше ничего.'
const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' } })

// Capture MAIN-process stderr (where process.emitWarning lands).
let mainStderr = ''
try { app.process().stderr?.on('data', (b) => { mainStderr += b.toString() }) } catch {}

const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())
async function outcome(page, ms = 45000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(1200)
    const d = await dump(page)
    if (!d) continue
    if ((d.pendingTools || []).some((t) => t.kind !== 'question' && !t.settled)) return 'GATED'
    if (!d.streaming && d.messages.some((m) => m.role === 'assistant') && (d.pendingTools || []).length === 0) return 'DONE'
  }
  return 'timeout'
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))

  // ---- 1. bypass ON → runs without asking ----
  console.log('\n[1] bypass ВКЛ → инструмент реально выполнился БЕЗ спроса')
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  await page.evaluate((c) => window.__zaryaAskAgent?.(c, 'claude-code'), CMD)
  const t1 = await outcome(page)
  ok('ход 1 завершился без гейта', t1 === 'DONE', t1)
  // DONE alone is vacuous (a text-only reply also finishes with no pending tool),
  // so require that a tool actually RAN — proof the bypass auto-allow path fired.
  const d1 = await dump(page)
  const toolRan = (d1?.messages || []).some((m) => (m.content || []).some((p) => p.type === 'tool_use' || p.type === 'tool_result'))
  ok('инструмент реально выполнился (auto-allow сработал, не текст-только)', toolRan, (d1?.messages || []).length)

  // ---- 2. toggle OFF live → next tool gates ----
  console.log('\n[2] bypass ВЫКЛ вживую (та же сессия) → следующий инструмент спрашивает')
  await page.evaluate(() => window.__zaryaBypassLive?.(false))
  await page.evaluate((c) => window.__zaryaFollowUp?.(c), CMD)
  const t2 = await outcome(page)
  ok('ход 2 запросил подтверждение', t2 === 'GATED', t2)
  // approve it to clean up
  await page.evaluate(() => window.__zaryaApproveFirst?.())
  await page.waitForTimeout(2500)

  // ---- 3. AskUserQuestion STILL shows in bypass mode ----
  console.log('\n[3] AskUserQuestion показывается ДАЖЕ в bypass (ключевой фикс)')
  await page.evaluate(() => window.__zaryaBypassLive?.(true))
  await page.evaluate(() =>
    window.__zaryaAskAgent?.(
      'Используй инструмент AskUserQuestion, чтобы задать РОВНО один вопрос с 3 вариантами: «какой цвет темы предпочитаешь». Ничего больше не делай до ответа.',
      'claude-code'
    )
  )
  let sawQuestion = false, answered = false, d = null
  const dl = Date.now() + 90000
  while (Date.now() < dl) {
    await page.waitForTimeout(1500)
    d = await dump(page)
    if (!d) continue
    if (d.error) break
    const q = (d.pendingTools || []).find((t) => t.kind === 'question' && !t.settled)
    if (q && !answered) {
      sawQuestion = true
      const opt = q.questions?.[0]?.options?.[0]?.label
      await page.evaluate((label) => window.__zaryaAnswerFirst?.(label), opt || 'Первый')
      answered = true
    }
    if (answered && !d.streaming && (d.pendingTools || []).length === 0) break
  }
  ok('виджет-вопрос всплыл несмотря на bypass', sawQuestion === true)
  ok('на вопрос удалось ответить, агент продолжил', answered === true && !d?.error)

  // ---- 4. no shadow warning in main stderr ----
  console.log('\n[4] Варнинг CAN_USE_TOOL_SHADOWED исчез из stderr')
  ok('нет CLAUDE_SDK_CAN_USE_TOOL_SHADOWED', !/CAN_USE_TOOL_SHADOWED/i.test(mainStderr), mainStderr.split('\n').filter((l) => /warn/i.test(l)).slice(0, 3))
  ok('нет утечки подсказок пикера (show all projects)', !/show all projects/i.test(mainStderr))

  console.log(`\n[bypass-question] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}
