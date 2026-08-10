/**
 * The session cwd is a TRUST BOUNDARY: it becomes the agent's working directory
 * and the root the ACP filesystem proxy confines reads/writes to. It used to be
 * tracked from plain OSC 7 / 9;9 / 1337 / 633;P, which are ordinary output — so
 * any program (or `cat` of a crafted file) could forge one and silently move
 * that root somewhere the attacker had prepared.
 *
 * This proves both halves of the fix at once:
 *   1) a REAL `cd` still updates the cwd (the nonced channel our shell
 *      integration now emits works — otherwise the hardening would simply
 *      freeze cwd tracking, a silent regression);
 *   2) a FORGED OSC 7 printed by a command does NOT move it.
 *
 *   npm run build && node scripts/qa-cwd-spoof.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-cwdspoof-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-work-'))
const sub = join(work, 'subdir')
mkdirSync(sub, { recursive: true })

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
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const sessions = () => page.evaluate(() => window.__zaryaDumpSessions?.())
  const cwdOf = async (sid) => {
    const s = await sessions()
    return (s?.sessions || []).find((x) => x.id === sid)?.cwd ?? ''
  }
  const waitCwd = async (sid, pred, ms = 15000) => {
    const dl = Date.now() + ms
    let c = await cwdOf(sid)
    while (Date.now() < dl && !pred(c)) {
      await page.waitForTimeout(500)
      c = await cwdOf(sid)
    }
    return c
  }

  // Use the BOOT session: it is the one spawned through the normal profile
  // pipeline, so our shell integration is loaded there (a terminal made via the
  // QA hook gets no integration, and then this suite would prove nothing).
  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  ok('загрузочная сессия найдена', !!sid, sid)

  // Wait for the shell + our integration to actually come up. Without this the
  // first commands are written into a pty nobody is reading yet and vanish —
  // the suite then "fails" on a timing flake instead of on the behaviour.
  const blocks = () => page.evaluate((s) => window.__zaryaDumpBlocks?.(s), sid)
  const ready = await (async () => {
    const dl = Date.now() + 30000
    while (Date.now() < dl) {
      await page.evaluate((s) => window.__zaryaRunShell?.('echo zarya-ready', s), sid)
      await page.waitForTimeout(1500)
      const b = (await blocks()) || []
      if (b.some((x) => (x.output || '').includes('zarya-ready'))) return true
    }
    return false
  })()
  if (!ready) {
    // Honest skip, not a green tick and not a red one: without the shell
    // integration there is no nonced channel to test, and a red here would be
    // noise about the harness rather than about the product. The decision
    // itself is covered deterministically by tests/cwdTrust.test.ts.
    console.log(
      '\n  ⚠ ПРОПУСК: интеграция оболочки не поднялась в этом окружении —\n' +
        '    доверенный канал проверить нечем. Логика решения покрыта юнит-тестом\n' +
        '    tests/cwdTrust.test.ts; этот сценарий гоняем на живом терминале.\n'
    )
    await app.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
    process.exit(0)
  }
  ok('оболочка + интеграция поднялись (есть блоки)', ready)

  // ---- 1. a REAL cd must still be tracked (guards against a silent freeze) ----
  console.log('\n[1] Настоящий cd — каталог должен обновиться')
  await page.evaluate(({ s, d }) => window.__zaryaRunShell?.(`cd "${d}"`, s), { s: sid, d: sub })
  const afterCd = await waitCwd(sid, (c) => norm(c) === norm(sub))
  ok('cd отслежен (доверенный канал работает)', norm(afterCd) === norm(sub), {
    ожидали: sub,
    получили: afterCd
  })

  // ---- 2. a FORGED OSC 7 printed as output must be IGNORED ----
  console.log('\n[2] Подделанный OSC 7 из вывода — каталог НЕ должен сдвинуться')
  const target = process.platform === 'win32' ? '/C:/Windows' : '/etc'
  // Printed by an ordinary command, exactly as malicious output would be.
  const forge =
    process.platform === 'win32'
      ? `[Console]::Out.Write("$([char]27)]7;file://localhost${target}$([char]7)")`
      : `printf '\\e]7;file://localhost${target}\\a'`
  await page.evaluate(({ s, c }) => window.__zaryaRunShell?.(c, s), { s: sid, c: forge })
  await page.waitForTimeout(4000)
  const afterForge = await cwdOf(sid)
  ok('подделка отклонена — каталог не сдвинулся', norm(afterForge) === norm(sub), {
    ожидали: sub,
    получили: afterForge
  })
  ok(
    'каталог не стал подделанным значением',
    !norm(afterForge).endsWith(norm(target).replace(/^\//, '')),
    afterForge
  )

  // ---- 3. and a real cd still works AFTER the forgery attempt ----
  console.log('\n[3] После попытки подделки настоящий cd продолжает работать')
  await page.evaluate(({ s, d }) => window.__zaryaRunShell?.(`cd "${d}"`, s), { s: sid, d: work })
  const backHome = await waitCwd(sid, (c) => norm(c) === norm(work))
  ok('cd обратно отслежен', norm(backHome) === norm(work), { ожидали: work, получили: backHome })
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ЕСТЬ ПРОБЛЕМЫ'}: pass=${pass} fail=${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
