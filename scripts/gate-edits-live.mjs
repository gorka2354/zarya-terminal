/**
 * «Правки без спроса» на НАСТОЯЩЕМ Claude Code (inc-25).
 *
 * Фейковый движок это доказать не может: авто-допуск живёт в `canUseTool`
 * драйвера, а фейк туда не ходит. А обещание тут такое, что проверять его на
 * подделке нельзя — речь о том, что выполнится без спроса.
 *
 * Что проверяем: при включённой ступени правка файла проходит МОЛЧА, а команда
 * оболочки в том же ходу всё равно поднимает гейт.
 *
 * Требует живого входа в Claude Code и тратит токены подписки.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-gate-live-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-gate-work-'))
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
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    NODE_ENV: 'production'
  }
})

const state = (page) =>
  page.evaluate(() => {
    const c = window.__zaryaDumpConv?.()
    if (!c) return null
    const tools = []
    for (const m of c.messages) for (const p of m.content) if (p.type === 'tool_use') tools.push(p.name)
    const texts = []
    for (const m of c.messages)
      for (const p of m.content)
        if (p.type === 'text' || p.type === 'notice') texts.push((p.text || '').slice(0, 200))
    return {
      streaming: c.streaming,
      editsAuto: c.editsAuto,
      error: c.error,
      gates: (c.pendingTools || []).filter((t) => !t.settled).map((t) => t.name),
      tools,
      texts
    }
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)

  // Работаем в пустой временной папке: агент пишет файл, и делать это в репозитории
  // нельзя — прогон обязан убирать за собой полностью.
  const sid = await page.evaluate((cwd) => window.__zaryaNewTerminal?.(cwd), work)
  await page.waitForTimeout(2500)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'claude-code'), sid)
  await page.evaluate((s) => window.__zaryaSetPaneEditsAuto?.(s, true), sid)
  await page.waitForTimeout(500)

  console.log('\n[1] Ступень включена до начала беседы')
  /*
   * Пути АБСОЛЮТНЫЕ, команда ИЗМЕНЯЮЩАЯ — оба выбора вынужденные.
   *
   * Относительный путь агент разрешает от своей рабочей папки, и промах прогона
   * выглядел бы как промах ступени. А безобидную команду (`echo`, `ls`) движок
   * разрешает сам, не спрашивая хост, — на ней нельзя проверить, что команды
   * по-прежнему спрашивают.
   */
  await page.evaluate((dir) =>
    window.__zaryaStartAgent?.(
      'claude-code',
      'Сделай ровно две вещи и ничего больше, без объяснений: 1) инструментом Write создай файл ' +
        dir +
        '\note.txt со словом «привет»; 2) инструментом Bash выполни команду `mkdir ' +
        dir +
        '\sub`.'
    ), work
  )

  // Ждём, пока агент упрётся в гейт или закончит.
  let seen = null
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000)
    seen = await state(page)
    if (seen?.gates?.length) break
    if (seen && !seen.streaming) break
  }
  console.log('  состояние:', JSON.stringify(seen))
  ok('беседа знает про ступень', seen?.editsAuto === true, seen)

  console.log('\n[2] Правка прошла молча, команда — со спросом')
  const wrote = existsSync(join(work, 'note.txt'))
  ok('файл создан без единого вопроса', wrote, { work })
  ok(
    'правка НЕ висит в гейтах',
    !(seen?.gates ?? []).some((n) => /write|edit/i.test(n)),
    seen?.gates
  )
  ok(
    'команда оболочки спрашивает',
    (seen?.gates ?? []).some((n) => /bash/i.test(n)),
    seen?.gates
  )
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // временная папка не удалилась — не повод ронять прогон
  }
  process.exit(fail ? 1 : 0)
}
