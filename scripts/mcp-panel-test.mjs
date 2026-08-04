/**
 * Вкладка «Инструменты» — здоровье MCP-серверов панели.
 *
 * Проверяется то, чего юнит-тест не видит: что человек РЕАЛЬНО видит состояние
 * каждого сервера, причину отказа дословно, цену в токенах и предупреждение о
 * том, чей конфиг меняет кнопка. И четыре отказа, которые легче всего
 * подменить пустотой:
 *   1. движок не умеет называть инструменты (не то же самое, что «их нет»);
 *   2. панель не запущена — снимок прошлый, и это сказано словами;
 *   3. без нажатия движок НЕ опрашивается (health-check запускает серверы
 *      по-настоящему: чужие процессы и секунды ожидания);
 *   4. «переподключить» на мёртвом сервере не рисует успех.
 *
 * Агенты — фейковые (ZARYA_FAKE_AGENT): ни сети, ни живого Claude.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const userData = mkdtempSync(join(tmpdir(), 'zarya-mcp-'))
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
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

const errors = []

try {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  /** Открыть настройки и перейти на вкладку по её названию. */
  const openTab = async (label) => {
    await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
    await page.waitForTimeout(400)
    await page.evaluate((text) => {
      const items = [...document.querySelectorAll('.zy-settings-nav-item')]
      const hit = items.find((el) => el.textContent?.includes(text))
      hit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, label)
    await page.waitForTimeout(600)
  }

  /** Строки серверов так, как их видит человек. */
  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.zy-tools-row')].map((el) => ({
        name: el.querySelector('.zy-tools-name')?.textContent ?? '',
        status: el.querySelector('.zy-tools-status')?.textContent ?? '',
        why: el.querySelector('.zy-tools-why')?.textContent ?? '',
        meta: el.querySelector('.zy-tools-meta')?.textContent ?? '',
        buttons: [...el.querySelectorAll('.zy-tools-btn')].map((b) => b.textContent)
      }))
    )

  /** Нажать кнопку в строке нужного сервера. */
  const clickIn = async (name, label) => {
    await page.evaluate(
      ([n, l]) => {
        const row = [...document.querySelectorAll('.zy-tools-row')].find(
          (el) => el.querySelector('.zy-tools-name')?.textContent === n
        )
        const btn = [...(row?.querySelectorAll('.zy-tools-btn') ?? [])].find((b) =>
          b.textContent?.includes(l)
        )
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      },
      [name, label]
    )
    await page.waitForTimeout(700)
  }

  console.log('\n[1] Вкладка есть и показывает инструменты ЖИВОЙ панели')
  const idC = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  ok('беседа на движке codex заведена', !!idC, idC)
  await page.waitForTimeout(1800)
  await openTab('Инструменты')
  const r1 = await rows()
  ok('серверы показаны', r1.length === 4, r1.length)
  ok(
    'сломанное и ждущее входа идут первыми, выключенное последним',
    r1.map((r) => r.name).join(',') === 'broken-one,needs-login,working-one,switched-off',
    r1.map((r) => r.name)
  )

  console.log('\n[2] Состояние словами, причина — дословно от движка')
  ok('упавший подписан «не отвечает»', r1[0].status.includes('не отвечает'), r1[0].status)
  ok('ждущий входа подписан «нужен вход»', r1[1].status.includes('нужен вход'), r1[1].status)
  ok('работающий подписан «работает»', r1[2].status.includes('работает'), r1[2].status)
  ok(
    'причина отказа показана целиком, без нашего пересказа',
    r1[0].why.includes('MCP endpoint not found'),
    r1[0].why
  )

  console.log('\n[3] Цена контекста — и она подписана как чужая')
  ok('у работающего названо число инструментов', /12/.test(r1[2].meta), r1[2].meta)
  // Разделитель разрядов — неразрывный пробел, поэтому здесь \s, а не пробел:
  // прогон проверяет ЧИСЛО на экране, а не наш выбор типографики.
  ok('и цена в токенах', /8\s400/.test(r1[2].meta), r1[2].meta)
  const ctx = await page.evaluate(
    () => document.querySelector('.zy-tools-context')?.textContent ?? ''
  )
  ok('строка контекста на месте', /42\s000/.test(ctx) && /200\s000/.test(ctx), ctx)
  ok('и сказано, что цифры движка', /движка/.test(ctx), ctx)

  if (shots) await page.screenshot({ path: join(shots, 'tools-1-list.png') })

  console.log('\n[3a] Ждущему входа не предлагают кнопку, которая не поможет')
  const login = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.zy-tools-row')].find(
      (el) => el.querySelector('.zy-tools-name')?.textContent === 'needs-login'
    )
    return {
      cmd: row?.querySelector('.zy-tools-cmd')?.textContent ?? '',
      buttons: [...(row?.querySelectorAll('.zy-tools-btn') ?? [])].map((b) => b.textContent)
    }
  })
  ok('«Переподключить» на нём нет', !login.buttons.some((b) => b?.includes('Переподключить')), login.buttons)
  ok('вместо неё — команда, которую можно выполнить руками', login.cmd === 'claude mcp login needs-login', login.cmd)

  console.log('\n[4] Человек предупреждён, ЧЕЙ конфиг меняет кнопка')
  const foot = await page.evaluate(
    () => document.querySelector('.zy-tools-foot')?.textContent ?? ''
  )
  ok('сказано про конфиг Claude Code', /claude\.json/.test(foot), foot)
  ok('и что это не настройки Зари', /не настройки Зари/.test(foot), foot)

  console.log('\n[5] Секретов на экране нет')
  const body = await page.evaluate(
    () => document.querySelector('.zy-set-section')?.textContent ?? ''
  )
  ok('ни env, ни заголовков, ни ключей', !/(Bearer|API_KEY|sk-|token=)/i.test(body), body.slice(0, 200))

  console.log('\n[6] «Выключить» работает и меняет подпись')
  await clickIn('working-one', 'Выключить')
  const r2 = await rows()
  const off = r2.find((r) => r.name === 'working-one')
  ok('сервер стал «выключен»', off?.status.includes('выключен'), off?.status)
  ok('и кнопка предлагает включить обратно', off?.buttons.some((b) => b?.includes('Включить')), off?.buttons)

  console.log('\n[7] «Переподключить» на мёртвом не рисует успех')
  await clickIn('broken-one', 'Переподключить')
  const note = await page.evaluate(
    () => document.querySelector('.zy-tools-note')?.textContent ?? ''
  )
  ok('показана причина отказа от движка', /connection refused/.test(note), note)
  const r3 = await rows()
  ok(
    'и сервер по-прежнему подписан как упавший',
    r3.find((r) => r.name === 'broken-one')?.status.includes('не отвечает'),
    r3[0]?.status
  )

  console.log('\n[8] Движок, который так не умеет, получает отказ словами')
  const idG = await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'привет'))
  ok('беседа на движке gemini заведена', !!idG, idG)
  await page.waitForTimeout(1500)
  await page.evaluate((id) => {
    const sel = document.querySelector('.zy-tools-select')
    if (!sel) return
    sel.value = id
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, idG)
  await page.waitForTimeout(700)
  const empty = await page.evaluate(
    () => document.querySelector('.zy-tools-empty')?.textContent ?? ''
  )
  ok('сказано «не называет свои инструменты», а не показан пустой список', /не называет/.test(empty), empty)
  ok('строк серверов при этом нет', (await rows()).length === 0)
  if (shots) await page.screenshot({ path: join(shots, 'tools-2-unsupported.png') })

  console.log('\n[9] Без живой панели движок НЕ опрашивается сам')
  const quiet = await page.evaluate(() =>
    window.zarya.agent.mcpStatus('codex', 'нет-такой-беседы')
  )
  ok('ответ помечен как несвежий', quiet?.stale === true, quiet)
  ok('и список пуст — движок не поднимали', (quiet?.servers ?? []).length === 0, quiet?.servers?.length)
  const probed = await page.evaluate(() =>
    window.zarya.agent.mcpStatus('codex', 'нет-такой-беседы', true)
  )
  ok('по явному нажатию движок отвечает', (probed?.servers ?? []).length === 4, probed?.servers?.length)

  console.log('\n[10] Окно ни на что не жалуется')
  ok('ни ошибок, ни предупреждений', errors.length === 0, errors.slice(0, 3))

  console.log(`\n[mcp-panel] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}

if (fail) process.exit(1)
