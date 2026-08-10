/**
 * Команды движка через «/» — на живом Claude Code.
 *
 * Проверяется не «есть ли список», а три места, где такие списки врут:
 *
 * 1. Список выскакивает посреди набора пути и съедает следующее нажатие — самая
 *    частая жалоба на чужие реализации.
 * 2. Точное совпадение оказывается не первым: в самом Claude Code это открытый
 *    баг, и Enter запускает не ту команду.
 * 3. Пока список грузится, показывают «0 команд» — человек читает это как
 *    «команд нет» и уходит.
 *
 * Прогону нужен настоящий Claude Code (SDK поднимает CLI), поэтому он живёт
 * отдельно от CI: `npm run qa:commands`.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-cmd-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

const list = (page) => page.locator('[data-command-list]')

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'claude-code'), sid)
  await page.waitForTimeout(500)

  console.log('\n[1] Список приходит от самого движка')
  const raw = await page.evaluate(() => window.zarya.agent.listCommands('claude-code'))
  ok('движок назвал свои команды', raw.source === 'engine', raw.source)
  ok('их больше десятка', raw.commands.length > 10, raw.commands.length)
  ok(
    'у команд есть описания',
    raw.commands.filter((c) => c.description).length > raw.commands.length / 2,
    raw.commands.filter((c) => c.description).length
  )
  ok(
    'подсказки аргументов приходят',
    raw.commands.some((c) => c.argumentHint),
    raw.commands.filter((c) => c.argumentHint).slice(0, 3)
  )
  ok(
    'служебного мусора нет',
    !raw.commands.some((c) => c.name.startsWith('__') || c.name === 'heapdump'),
    raw.commands.filter((c) => c.name.startsWith('__')).map((c) => c.name)
  )
  ok(
    'дублей нет',
    new Set(raw.commands.map((c) => c.name.toLowerCase())).size === raw.commands.length
  )

  console.log('\n[2] Жест «/» открывает список — и только там, где надо')
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('/rev')
  // Первый вызов поднимает процесс SDK — это секунды, и всё это время список
  // обязан говорить «спрашиваю движок», а не «0 команд».
  await page.waitForTimeout(5000)
  ok('список открылся', (await list(page).count()) === 1)

  const shown = await page.evaluate(() => {
    const el = document.querySelector('[data-command-list]')
    return {
      names: [...el.querySelectorAll('.zy-cmdlist-name')].map((x) => x.textContent),
      first: el.querySelector('.zy-cmdlist-item--on .zy-cmdlist-name')?.textContent,
      source: el.querySelector('.zy-cmdlist-source')?.textContent?.trim()
    }
  })
  ok('нашлись команды по «rev»', shown.names.length > 0, shown.names.slice(0, 4))
  ok('точное совпадение первое', shown.first === '/review', shown)
  ok('шапка называет источник', /список от движка/.test(shown.source || ''), shown.source)

  console.log('\n[3] Enter подставляет, а не отправляет')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  ok('в строке оказалась команда', (await page.inputValue('.zy-agentbar-input')) === '/review')
  ok('список закрылся', (await list(page).count()) === 0)

  console.log('\n[4] В пути и в URL список не лезет')
  for (const text of ['cd src/main', 'открой https://example.com', 'посмотри /etc/hosts']) {
    await page.fill('.zy-agentbar-input', '')
    await page.keyboard.type(text)
    await page.waitForTimeout(250)
    ok(`«${text}» список не открывает`, (await list(page).count()) === 0)
  }

  console.log('\n[5] Esc убирает подсказку, а не текст')
  await page.fill('.zy-agentbar-input', '')
  await page.keyboard.type('/pl')
  await page.waitForTimeout(600)
  ok('список открыт', (await list(page).count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  ok('список закрыт', (await list(page).count()) === 0)
  ok('набранное осталось', (await page.inputValue('.zy-agentbar-input')) === '/pl')
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временный профиль */
  }
}

console.log(`\n[commands] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
