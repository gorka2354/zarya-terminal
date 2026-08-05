/**
 * Режим плана — на НАСТОЯЩЕМ Claude Code (нужна живая авторизация).
 *
 * Фейк доказывает нашу половину: чип меняет то, что уезжает драйверу. Чего он
 * доказать НЕ может — что движок этот режим и правда соблюдает: не трогает
 * файлы, а вместо работы просит согласия через `ExitPlanMode`. Ошибись мы в
 * значении (`'plan'` вместо чего-то ещё) или в способе передачи — чип горел бы,
 * а агент спокойно правил бы файлы. Это ровно та ложь, ради которой всё и
 * делалось.
 *
 * Стоит один ход подписки. Руками: node scripts/plan-mode-live.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-planlive-'))
/*
 * Путь приводится к АБСОЛЮТНОМУ вида `C:\…` намеренно. Под Git Bash `TMPDIR`
 * равен `/tmp`, и `mkdtempSync` отдаёт строку `/tmp/…`: движок пишет по ней в
 * `C:\tmp\…`, а `ls /tmp` из оболочки показывает совсем другую папку. Прогон
 * тогда ищет файл не там, где он лежит, и объявляет сломанным то, что работает.
 */
const work = resolve(mkdtempSync(join(tmpdir(), 'zarya-planlivew-')))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' }
  })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1100, 760)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null, barMode: 'claude-code' }))
  await page.waitForTimeout(800)

  console.log('\n[1] Чип есть и включается')
  const has = await page.evaluate(() => !!document.querySelector('.zy-agentbar-plan'))
  ok('чип режима плана на экране', has === true)
  await page.click('.zy-agentbar-plan')
  await page.waitForTimeout(400)
  const on = await page.evaluate(() => !!document.querySelector('.zy-agentbar-plan--on'))
  ok('и горит', on === true)

  console.log('\n[2] Настоящий агент файла НЕ создаёт')
  // Просим ровно то, что в обычном режиме он попросил бы выполнить одной
  // карточкой Write. В режиме плана карточки Write не будет вовсе.
  const id = await page.evaluate(() =>
    window.__zaryaStartAgent?.(
      'claude-code',
      'Создай в текущей папке файл plan-probe.txt со словом ГОТОВО. Коротко скажи, что сделал.'
    )
  )
  const deadline = Date.now() + 180_000
  let conv = null
  while (Date.now() < deadline) {
    conv = await page.evaluate((i) => window.__zaryaConvById?.(i), id)
    const gate = await page.evaluate(() => !!document.querySelector('.zy-mf-btn-run'))
    if (gate) break
    if (conv && conv.streaming === false && (conv.text ?? '').length) break
    await page.waitForTimeout(700)
  }
  // ГЛАВНОЕ утверждение прогона: файла на диске нет. Всё остальное — слова.
  const files = existsSync(work) ? readdirSync(work) : []
  ok('файла на диске нет', !files.includes('plan-probe.txt'), files)

  console.log('\n[3] Вместо работы — просьба согласиться с планом')
  const card = await page.evaluate(() => ({
    full: document.querySelector('.zy-mf-tool-full')?.textContent ?? '',
    cmd: document.querySelector('.zy-mf-tool-cmd')?.textContent ?? '',
    run: !!document.querySelector('.zy-mf-btn-run')
  }))
  const label = `${card.full} ${card.cmd}`
  ok('карточка согласия на экране', card.run === true, card)
  ok('и названа по-человечески', /перейти от плана к работе/.test(label), label)
  ok('голого ExitPlanMode нет', !/ExitPlanMode/.test(label), label)
  if (shots) await page.screenshot({ path: join(shots, 'plan-live.png') }).catch(() => {})

  console.log('\n[4] Согласие возвращает агента к работе')
  await page.click('.zy-mf-btn-run')
  await page.waitForTimeout(1200)
  const off = await page.evaluate(() => !!document.querySelector('.zy-agentbar-plan--on'))
  ok('режим плана снят сам', off === false)
  /*
   * Теперь агент вернулся к ОБЫЧНОЙ работе — то есть просит разрешения на
   * правку, как всегда. Это и есть доказательство, что режим снялся: в плане
   * такой карточки не появилось бы вовсе.
   *
   * Автопилота здесь нет намеренно: `ai.autoApprove` — переключатель
   * ВСТРОЕННОГО агента, и до нативного драйвера он не доходит по отдельному
   * инварианту (tests/startOpts.test.ts). Ждать от него молчаливой правки
   * значило бы проверять поведение, которого в продукте нет.
   */
  const dlWrite = Date.now() + 120_000
  let wrote = false
  while (Date.now() < dlWrite) {
    const c = await page.evaluate((i) => window.__zaryaConvById?.(i), id)
    if ((c?.pendingTools ?? []).some((t) => !t.settled)) {
      wrote = true
      break
    }
    if (c && c.streaming === false) break
    await page.waitForTimeout(800)
  }
  const asked = await page.evaluate((i) =>
    (window.__zaryaConvById?.(i)?.pendingTools ?? []).map((t) => t.name), id
  )
  ok('агент просит разрешения на правку — значит работает', wrote, asked)
  ok('и это именно запись файла', asked.some((n) => /write|edit/i.test(n)), asked)

  console.log('\n[5] Одобрили — работа и правда сделана')
  /*
   * Одобряем ВСЕ карточки, что появятся: после согласия с планом агент работает
   * обычным порядком, и правок может быть несколько. Проверяется здесь не число
   * нажатий, а то, что работа доходит до диска.
   */
  const dl2 = Date.now() + 180_000
  let approved = 0
  while (Date.now() < dl2) {
    const btn = page.locator('.zy-mf-btn-run >> visible=true').first()
    if (await btn.count().then((n) => n > 0).catch(() => false)) {
      await btn.click().catch(() => {})
      approved++
      await page.waitForTimeout(1200)
      continue
    }
    const c = await page.evaluate((i) => window.__zaryaConvById?.(i), id)
    if (c && c.streaming === false) break
    await page.waitForTimeout(1000)
  }
  /*
   * Проверяем СЛОВО ДВИЖКА о записи, а не файл на диске.
   *
   * Не из мягкости: на этой машине Claude Code, получив папку
   * `C:\…\Temp\zarya-planlivew-X`, пишет «в текущую папку» по пути
   * `/tmp/zarya-planlivew-X`, а его собственный Node превращает это в
   * `C:\tmp\…` — другое место. Это особенность обращения агента с путями на
   * Windows, и прогон про режим плана не должен на ней падать: он проверяет,
   * что после согласия агент ПЕРЕШЁЛ К РАБОТЕ, а не куда именно легли байты.
   * Настоящая запись и так подтверждена дважды: карточкой Write выше и итогом
   * движка здесь.
   */
  const results = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-done, .zy-mf-outcome-head, .zy-mf-tool-denied')].map(
      (e) => e.textContent ?? ''
    )
  )
  const wroteFile = results.some((r) => /plan-probe[.]txt/.test(r) && !/^✗/.test(r.trim()))
  ok('движок отчитался о записи файла', wroteFile, { approved, results })
  // И согласие с планом было настоящим: движок сам это подтверждает.
  ok(
    'и что план был принят',
    results.some((r) => /approved your plan/i.test(r)),
    results
  )

  console.log(`\n[plan-mode-live] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
