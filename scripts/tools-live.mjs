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
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', ZARYA_NO_UPDATE_CHECK: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  const id = await page.evaluate(() =>
    // Просим взять НАСТОЯЩИЙ скилл: только так проверяется, что Заря замечает
    // срабатывание живого движка, а не разыгранное фейком. Скилл дешёвый и
    // безобидный — он только отвечает документацией.
    window.__zaryaStartAgent?.('claude-code', 'вызови скилл claude-api, потом ответь словом: тут')
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

  // Скиллы: сколько их и во сколько обходятся описания в КАЖДОМ запросе. Тело
  // грузится по требованию, а описание лежит в контексте всегда — иначе агент
  // не знал бы, что скилл существует.
  // Кадр начала раздела — до раскрытия: так виден заголовок с итогом и первые,
  // самые дорогие строки, то есть ровно то, ради чего сюда заходят.
  await page.evaluate(() => {
    document.querySelector('.zy-skills-head')?.scrollIntoView({ block: 'start' })
  })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(out, 'tools-live-skills.png') })
  console.log('кадр скиллов:', join(out, 'tools-live-skills.png'))

  // Раскрываем список целиком: у человека их бывает под сотню, и проверять надо
  // то, что он увидит нажатием, а не первые двенадцать строк.
  await page.evaluate(() => {
    const b = document.querySelector('.zy-skills-more')
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(500)
  const skRows = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-row')].map((el) => ({
      name: el.querySelector('.zy-skills-name')?.textContent ?? '',
      src: el.querySelector('.zy-skills-src')?.textContent ?? '',
      price: el.querySelector('.zy-skills-price')?.textContent ?? '',
      // Подпись ВЫБРАННОЙ опции, а не её код: на экране человек читает слово, и
      // проверять надо то же самое, иначе прогон подтвердит не тот текст.
      state:
        el.querySelector('.zy-skills-select')?.selectedOptions?.[0]?.textContent ??
        el.querySelector('.zy-skills-state')?.textContent ??
        '',
      managed: !!el.querySelector('.zy-skills-select')
    }))
  )
  const skTotal = await page.evaluate(
    () => document.querySelector('.zy-skills-total')?.textContent ?? ''
  )
  const skUsed = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-row')]
      .filter((el) => el.querySelector('.zy-skills-used'))
      .map((el) => el.querySelector('.zy-skills-name')?.textContent ?? '')
  )
  const skSub = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-sub')].map((el) => el.textContent ?? '')
  )
  console.log(`\nскиллов на экране: ${skRows.length} — ${skTotal}`)
  console.log('сработали:', skUsed.length ? skUsed.join(', ') : '—', '|', skSub.join(' · '))
  for (const r of skRows.slice(0, 10))
    console.log(` • ${r.name} — ${r.price} (${r.src}) — ${r.state}`)

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
  check('настоящие скиллы человека показаны поимённо', skRows.length > 0, skRows.length)
  // Живой движок объявляет вызов внутри ответа модели, а не отдельным событием:
  // проверка именно здесь, потому что фейк этого пути не воспроизводит.
  check(
    'сработавший скилл замечен на живом движке',
    skUsed.length > 0 && skSub.some((x) => /сработали/.test(x)),
    { skUsed, skSub }
  )
  check(
    'у каждого названа цена — хотя бы честным «вне контекста»',
    skRows.every((r) => r.price.trim()),
    skRows.filter((r) => !r.price.trim()).map((r) => r.name)
  )
  check('итог назван и он про КАЖДЫЙ запрос', /токенов/.test(skTotal) && /запрос/.test(skTotal), skTotal)
  check(
    'состояние есть у каждой строки',
    skRows.every((r) => r.state),
    skRows.filter((r) => !r.state).map((r) => r.name)
  )
  // Главный отказ раздела: `skillOverrides` не действует на плагинные скиллы, и
  // переключатель на них был бы кнопкой, которая делает вид.
  check(
    'плагинными отсюда не управляем — переключателя у них нет',
    skRows.filter((r) => r.src === 'плагин').every((r) => !r.managed),
    skRows.filter((r) => r.src === 'плагин' && r.managed).map((r) => r.name)
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
