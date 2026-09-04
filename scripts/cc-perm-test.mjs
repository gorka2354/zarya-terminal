/**
 * Validates the canUseTool round-trip (the mechanism AskUserQuestion also uses):
 * ask Claude Code to run a shell command → a permission gate must surface as a
 * pendingTool → approve it → the tool executes in the SDK subprocess and a
 * tool_result comes back → the turn completes. Proves the permission resolve
 * path (renderer click -> IPC -> driver resolves canUseTool) works in Electron.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-ccp-'))
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
const errors = []
let failed = false
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForTimeout(2500)

  /*
   * КОМАНДА С ПОБОЧНЫМ ДЕЙСТВИЕМ, А НЕ `echo`.
   *
   * Здесь стоял `echo zarya-native-ok`, и выпускной прогон 0.7.8 показал, что
   * карточка на него больше не поднимается: движок считает такую команду
   * безопасной и выполняет сам, не спрашивая Зарю. Проверка при этом молчала —
   * печатала «approved: false» и завершалась успехом, то есть сценарий, который
   * существует ради round-trip разрешения, годами мог не проверять ничего.
   *
   * Проверено контролем: на коммите до правок 0.7.8 поведение то же самое, так
   * что дело в движке, а не в Заре.
   *
   * Пишем файл во временную папку прогона: побочное действие — ровно то, ради
   * чего карточка и существует, а папка уходит вместе с прогоном.
   */
  const probe = join(userData, 'zarya-perm-probe.txt').replace(/\\/g, '/')
  await page.evaluate(
    (p) =>
      window.__zaryaAskAgent?.(
        `Запусти в bash ровно одну команду: echo zarya-native-ok > "${p}" . Ничего больше не делай.`,
        'claude-code'
      ),
    probe
  )

  let approved = false
  const deadline = Date.now() + 90000
  let dump = null
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    dump = await page.evaluate(() => window.__zaryaDumpConv?.())
    if (!dump) continue
    if (dump.error) break
    const pend = (dump.pendingTools || []).find((t) => !t.settled)
    if (pend && !approved) {
      console.log('  >> permission gate surfaced for tool:', pend.name, '— approving')
      await page.evaluate(() => window.__zaryaApproveFirst?.())
      approved = true
    }
    const hasResult = (dump.messages || []).some((m) =>
      m.content.some((p) => p.type === 'tool_result')
    )
    if (hasResult && !dump.streaming && (dump.pendingTools || []).length === 0) break
  }

  console.log('=== approved:', approved, '| streaming:', dump?.streaming, '| error:', dump?.error)
  for (const m of dump?.messages || []) {
    const txt = m.content
      .map((p) =>
        p.type === 'text'
          ? p.text
          : p.type === 'tool_use'
            ? `[tool_use ${p.name} ${JSON.stringify(p.input).slice(0, 80)}]`
            : p.type === 'tool_result'
              ? `[tool_result ${p.isError ? 'ERR ' : ''}${(p.content || '').slice(0, 80)}]`
              : ''
      )
      .join(' ')
    console.log(`  ${m.role}: ${txt.slice(0, 200)}`)
  }
  console.log('=== console errors (' + errors.length + '):')
  for (const e of errors.slice(0, 10)) console.log('  !', e.slice(0, 200))

  /*
   * МОЛЧАНИЕ ЗДЕСЬ БЫЛО ХУЖЕ ПАДЕНИЯ.
   *
   * Сценарий печатал итог и всегда завершался успехом: «approved: false»
   * читалось как строка диагностики, а означало, что карточка не поднялась
   * вовсе — то есть проверять round-trip разрешения было нечем. Прогон, который
   * молча перестал проверять своё, — это ложное «всё зелено».
   */
  const ranTool = (dump?.messages || []).some((m) =>
    m.content.some((p) => p.type === 'tool_result')
  )
  if (!approved) {
    console.log(
      '\n✗ ПРОВАЛ: карточка разрешения не поднялась —',
      ranTool
        ? 'движок выполнил команду сам, минуя canUseTool'
        : 'и инструмент не выполнился вовсе'
    )
    failed = true
  } else if (!ranTool) {
    console.log('\n✗ ПРОВАЛ: карточку одобрили, но результат инструмента не пришёл')
    failed = true
  } else {
    console.log('\n✓ round-trip разрешения работает: карточка → одобрение → результат')
  }
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}

process.exit(failed ? 1 : 0)
