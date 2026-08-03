/**
 * Живой прогон вкладки «Инструменты» на НАСТОЯЩЕМ Claude Code.
 *
 * Зачем отдельно от `mcp-panel-test`: тот гоняет разыгранные состояния и живёт
 * в CI, а здесь проверяется то, чего фейк не даст — настоящий конфиг человека
 * со всеми его серверами, чужими именами (`claude.ai Notion` с пробелом),
 * незнакомыми областями (`dynamic`) и реальными причинами отказов. Требует
 * живого логина Claude, поэтому в CI не ходит: `npm run qa:tools-live`.
 *
 * Только СМОТРИТ: ни «выключить», ни «переподключить» здесь не нажимается —
 * `~/.claude.json` принадлежит Claude Code, а не нам, и прогон не имеет права
 * менять рабочий конфиг человека. Профиль самой Зари — временный.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const out = process.env.DIAG_OUT || tmpdir()
const userData = mkdtempSync(join(tmpdir(), 'zarya-toolslive-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', ZARYA_NO_UPDATE_CHECK: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  const id = await page.evaluate(() =>
    window.__zaryaStartAgent?.('claude-code', 'ответь одним словом: тут')
  )
  console.log('беседа:', id)
  // Ждём, пока сессия действительно поднимется: до этого статусов ещё нет.
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000)
    const c = await page.evaluate((x) => window.__zaryaConvById?.(x), id)
    if (c && !c.streaming && c.text) {
      console.log('ответ:', String(c.text).slice(0, 60))
      break
    }
  }

  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.zy-settings-nav-item')]
    items.find((el) => el.textContent?.includes('Инструменты'))?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    )
  })
  // Health-check настоящих серверов — это запуск чужих процессов, ему нужно время.
  await page.waitForTimeout(20000)

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-tools-row')].map((el) => ({
      name: el.querySelector('.zy-tools-name')?.textContent,
      status: el.querySelector('.zy-tools-status')?.textContent,
      why: el.querySelector('.zy-tools-why')?.textContent,
      meta: el.querySelector('.zy-tools-meta')?.textContent
    }))
  )
  console.log(`\nсерверов: ${rows.length}`)
  for (const r of rows) console.log(` • ${r.name} — ${r.status}${r.why ? ' — ' + r.why : ''}\n   ${r.meta}`)
  const ctx = await page.evaluate(
    () => document.querySelector('.zy-tools-context')?.textContent ?? ''
  )
  console.log('\n' + ctx)

  // Проверки на настоящих данных — то, что фейк подтвердить не может.
  let bad = 0
  const check = (name, cond, extra) => {
    if (cond) console.log('  ✓', name)
    else {
      bad++
      console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
    }
  }
  console.log('')
  check('серверы настоящего конфига получены', rows.length > 0, rows.length)
  const all = JSON.stringify(rows)
  check('на экране нет ни ключей, ни заголовков', !/(Bearer|API_KEY|sk-[A-Za-z0-9]|token=)/i.test(all))
  check(
    'у каждого сервера состояние названо словом, а не кодом',
    rows.every((r) => r.status && !/[a-z]+-[a-z]+/.test(r.status)),
    rows.map((r) => r.status)
  )
  const logins = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-tools-cmd')].map((el) => el.textContent)
  )
  check(
    'команды входа скопируются как есть (имена с пробелом — в кавычках)',
    logins.every((c) => !/login [^"]*\s[^"]*$/.test(c ?? '')),
    logins
  )
  if (bad) process.exitCode = 1

  await page.screenshot({ path: join(out, 'tools-live.png') })
  console.log('кадр:', join(out, 'tools-live.png'))
  await page.evaluate(() => {
    const box = document.querySelector('.zy-settings-body') || document.querySelector('.zy-set-section')?.parentElement
    if (box) box.scrollTop = box.scrollHeight
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'tools-live-bottom.png') })
  console.log('кадр низа:', join(out, 'tools-live-bottom.png'))
} finally {
  await app.close()
}
