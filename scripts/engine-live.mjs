/**
 * Вкладка «Движок» на НАСТОЯЩЕМ Claude Code (inc-29).
 *
 * Фейк проверяет показ; здесь проверяется то, ради чего экран сделан: что
 * названный путь — настоящий, версия совпадает с ответом самого CLI, вход
 * прочитан у движка, а отчёт `claude doctor` — его собственные слова.
 *
 * Отдельно проверяется `/init`: команда движка, которую план числил
 * недостающей. Если она уже работает через палитру — это не пробел, и знать об
 * этом надо до того, как для неё что-то напишут.
 *
 * Требует живого входа в Claude Code и тратит токены подписки.
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-eng-live-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-eng-lwork-'))

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
const note = (text) => console.log('  ·', text)

// Правда «со стороны»: спрашиваем CLI напрямую и сверяем с тем, что показал
// экран. Иначе прогон проверял бы согласованность Зари с самой собой.
let realVersion = ''
try {
  // `shell: true` — на Windows без него не срабатывает PATHEXT, и `claude`
  // «не находится», хотя он есть: сверка со стороны молча выключалась бы.
  realVersion = String(
    execFileSync('claude --version', { encoding: 'utf8', shell: true })
  ).trim()
} catch {
  realVersion = ''
}

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
  await page.waitForTimeout(3500)
  const sid = await page.evaluate((cwd) => window.__zaryaNewTerminal?.(cwd), work)
  await page.waitForTimeout(2500)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'claude-code'), sid)
  await page.waitForTimeout(600)
  // Беседа нужна вкладке: она показывает состояние КОНКРЕТНОЙ панели.
  const convId = await page.evaluate(() =>
    window.__zaryaStartAgent?.('claude-code', 'ответь одним словом: ок')
  )
  await page.waitForTimeout(1500)

  console.log('\n[1] Настоящий путь и настоящая версия')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'engine' }))
  // Пути и версии — это два запуска `--version` плюс чтение входа.
  await page.waitForTimeout(4000)
  const bins = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-eng-bin')).map((el) => ({
      chosen: el.className.includes('--chosen'),
      ver: el.querySelector('.zy-eng-ver')?.textContent ?? '',
      path: el.querySelector('.zy-eng-path')?.textContent ?? '',
      why: el.querySelector('.zy-eng-why')?.textContent ?? ''
    }))
  )
  console.log('  найдено:', JSON.stringify(bins.map((b) => ({ c: b.chosen, v: b.ver }))))
  ok('хоть один файл найден', bins.length >= 1, bins.length)
  const chosen = bins.find((b) => b.chosen)
  ok('выбранный назван', !!chosen, bins)
  ok('его путь существует на диске', !!chosen && existsSync(chosen.path), chosen?.path)
  ok('причина выбора названа', (chosen?.why ?? '').length > 10, chosen?.why)
  if (realVersion) {
    const num = /(\d+\.\d+\.\d+)/.exec(realVersion)?.[1]
    const shown = bins.map((b) => b.ver).join(' ')
    ok('версия совпадает с ответом самого CLI', !!num && shown.includes(num), { num, shown })
  } else {
    note('claude в PATH не нашёлся — сверить версию со стороны нечем')
  }

  console.log('\n[2] Вход прочитан у движка')
  const auth = await page.evaluate(
    () => document.querySelector('.zy-eng-auth')?.textContent ?? ''
  )
  ok('строка входа есть', auth.length > 0, auth)
  ok('и это не «движок не ответил»', !/не ответил/i.test(auth), auth)

  console.log('\n[3] Отчёт движка — его собственные слова')
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.zy-eng-btn'))
    btns.find((b) => /спросить/i.test(b.textContent ?? ''))?.click()
  })
  // `claude doctor` живёт около четырёх секунд.
  let report = ''
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    report = await page.evaluate(
      () => document.querySelector('.zy-eng-report')?.textContent ?? ''
    )
    if (report) break
  }
  ok('отчёт пришёл', report.length > 0, report.slice(0, 80))
  ok('это правда отчёт doctor', /Claude Code doctor/i.test(report), report.slice(0, 120))
  ok('в нём назван путь', /Path:/i.test(report), report.slice(0, 200))
  if (shots) await page.screenshot({ path: join(shots, 'live-engine.png') })

  console.log('\n[4] /init — команда движка: есть ли она вообще')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false }))
  await page.waitForTimeout(500)
  // Команды движка спрашиваем ПО БЕСЕДЕ: без неё живой сессии нет, и движку
  // просто некого спросить — пустой ответ означал бы не «команд нет», а «мы не
  // туда постучались».
  const res = await page.evaluate(async (id) => {
    const r = await window.zarya.agent.listCommands?.('claude-code', id)
    return r && Array.isArray(r.commands)
      ? { source: r.source, note: r.note ?? null, names: r.commands.map((c) => c.name) }
      : null
  }, convId)
  if (!res) {
    note('движок команд не называет — палитре «/» показывать нечего')
  } else {
    console.log('  источник:', res.source, '· команд:', res.names.length)
    ok('список пришёл ОТ ДВИЖКА, а не выдуман', res.source === 'engine', res.source)
    ok('команды есть', res.names.length > 0, res.names.length)
    // `/init` план числил недостающим. Если он уже здесь — это не пробел, и
    // писать для него отдельную кнопку значило бы удвоить существующее.
    ok('и /init среди них', res.names.some((n) => /^init$/i.test(n)), res.names.slice(0, 40))
  }

  console.log(`\n[engine-live] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // временная папка не удалилась — не повод ронять прогон
  }
}
process.exit(fail ? 1 : 0)
