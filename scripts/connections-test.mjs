/**
 * Сохранённые подключения: экран пишет профиль тем же путём, что и правка файла.
 *
 *   node scripts/connections-test.mjs
 *
 * Главное здесь — не форма, а ГРАНИЦА. Профиль это программа, которую
 * приложение будет запускать при каждом старте, поэтому его добавление проходит
 * через стража в главном процессе с подтверждением человека. Прогон проверяет,
 * что экран ходит той же дверью: собирает argv правильно, отказ показывает
 * отказом и ничего не пишет молча.
 *
 * Диалог подтверждения нажать из прогона нечем — он системный. Поэтому здесь
 * проверяется всё ДО него и всё ПОСЛЕ, а сам гейт закрыт отдельной проверкой
 * («отказ оставляет список прежним»): её обеспечивает `ZARYA_PROFILE_DIALOG`.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}
const note = (...a) => console.log('   ·', ...a)

const ud = mkdtempSync(join(tmpdir(), 'zarya-conn-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const launch = (dialog) =>
  electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: ud,
      // Ответ системного окна подтверждения: нажать его из прогона нечем.
      ZARYA_PROFILE_DIALOG: dialog,
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    }
  })

const stored = () => {
  try {
    return (
      JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')).terminal?.customProfiles ?? []
    )
  } catch {
    return []
  }
}

/** Заполнить форму и нажать «Сохранить». */
async function addHost(page, { host, user, port }) {
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'terminal' }))
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.zy-conn button')]
    btns.find((b) => /Добавить SSH/.test(b.textContent ?? ''))?.click()
  })
  await page.waitForTimeout(400)
  const set = async (ph, value) => {
    const el = await page.$(`.zy-conn input[placeholder^="${ph}"]`)
    if (el) await el.fill(value)
  }
  await set('Хост', host)
  await set('Пользователь', user ?? '')
  if (port) await set('Порт', port)
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.zy-conn button')]
    btns.find((b) => /Сохранить/.test(b.textContent ?? ''))?.click()
  })
  await page.waitForTimeout(2500)
}

console.log('\n[1] Отказ в окне подтверждения НИЧЕГО не записывает')
let app = await launch('decline')
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await addHost(page, { host: '100.81.218.50', user: 'egor' })
  ok('на диске профилей нет', stored().length === 0, stored())
  const text = await page.evaluate(() => document.querySelector('.zy-conn-err')?.textContent ?? '')
  note('сообщение:', JSON.stringify(text))
  // Молчаливое закрытие формы читалось бы как «сохранено».
  ok('экран сказал про отказ, а не закрыл форму', /отклонено/i.test(text), text)
} finally {
  await app.close()
}

console.log('\n[2] Согласие записывает профиль — и argv собран правильно')
app = await launch('accept')
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await addHost(page, { host: '100.81.218.50', user: 'egor', port: '22' })
  const list = stored()
  note('на диске:', JSON.stringify(list))
  ok('профиль записан', list.length === 1, list)
  const p = list[0] ?? {}
  ok('запускается системный ssh', /ssh(\.exe)?$/i.test(String(p.path ?? '')), p.path)
  // Опции ПЕРЕД целью: иначе они уедут удалённой команде и просто пропадут.
  ok(
    'аргументы в правильном порядке',
    JSON.stringify(p.args) === '["-p","22","egor@100.81.218.50"]',
    p.args
  )
  // Скрипт интеграции остаётся на этой машине — обещать блоки на той нельзя.
  ok('интеграция выключена честно', p.integration === 'none', p.integration)

  if (process.env.ZARYA_SHOTS) {
    await page.evaluate(() =>
      window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'terminal' })
    )
    await page.waitForTimeout(800)
    await page.evaluate(() =>
      document.querySelector('.zy-conn')?.scrollIntoView({ block: 'center' })
    )
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(process.env.ZARYA_SHOTS, 'connections.png') })
  }

  console.log('\n[3] Профиль виден в выборе панели')
  await page.waitForTimeout(500)
  const profiles = await page.evaluate(() => window.__zaryaDumpProfiles?.() ?? null)
  ok(
    'новый профиль попал в список',
    Array.isArray(profiles) && profiles.some((x) => /100\.81\.218\.50/.test(x.name)),
    profiles
  )
} finally {
  await app.close()
}

try {
  rmSync(ud, { recursive: true, force: true })
} catch {
  /* временная папка */
}

console.log(`\n[connections] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
