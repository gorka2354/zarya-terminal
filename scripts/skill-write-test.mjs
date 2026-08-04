/**
 * Запись состояния скилла в настоящий файл настроек — настоящим драйвером.
 *
 * Юниты проверяют чистую функцию, `skills-panel-test` — экран на фейковом
 * агенте. Между ними остаётся то, что ломается тише всего и дороже всего: путь
 * до файла, чтение-правка-запись и сохранность чужих ключей. Здесь идёт ровно
 * этот кусок — через `claude-code`, тот самый драйвер, что пишет людям.
 *
 * ЧУЖОЙ КОНФИГ НЕ ТРОГАЕМ. Дом подменён (`USERPROFILE`/`HOME` → временная
 * папка), поэтому настоящий `~/.claude/settings.json` не открывается ни на
 * чтение, ни на запись. Проверка этого — последним пунктом, и она не
 * формальность: ошибка здесь означала бы испорченный конфиг человека.
 *
 * Живой Claude не нужен: `skillOverride` работает и без сессии — он про файл, а
 * не про беседу.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
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

const realHome = homedir()
const fakeHome = mkdtempSync(join(tmpdir(), 'zarya-skillhome-'))
mkdirSync(join(fakeHome, '.claude'), { recursive: true })
const settingsPath = join(fakeHome, '.claude', 'settings.json')
// Чужие ключи кладём заранее: главное, что проверяется, — они переживут правку.
writeFileSync(
  settingsPath,
  JSON.stringify({ model: 'opus', hooks: { PreToolUse: [1] }, effortLevel: 'high' }, null, 2)
)
const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'))

const userData = mkdtempSync(join(tmpdir(), 'zarya-skillwrite-'))
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
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  /** Позвать настоящий драйвер так же, как это делает окно. */
  const set = (name, state) =>
    page.evaluate(
      ([n, s]) => window.zarya.agent.skillOverride('claude-code', undefined, n, s),
      [name, state]
    )

  console.log('\n[1] Состояние доходит до файла в виде, который понимает движок')
  const r1 = await set('code-review', 'user-invocable-only')
  ok('драйвер ответил успехом', r1?.ok === true, r1)
  ok(
    'в файле ровно то слово, что читает Claude Code',
    read().skillOverrides?.['code-review'] === 'user-invocable-only',
    read().skillOverrides
  )

  console.log('\n[2] Чужие ключи переживают правку')
  ok('model на месте', read().model === 'opus', read().model)
  ok('hooks на месте', JSON.stringify(read().hooks) === '{"PreToolUse":[1]}', read().hooks)
  ok('effortLevel на месте', read().effortLevel === 'high', read().effortLevel)

  console.log('\n[3] Второй скилл добавляется, не затирая первый')
  await set('dataviz', 'off')
  ok(
    'оба состояния в файле',
    read().skillOverrides?.['code-review'] === 'user-invocable-only' &&
      read().skillOverrides?.dataviz === 'off',
    read().skillOverrides
  )

  console.log('\n[4] Возврат в «в работе» не оставляет следов Зари')
  await set('code-review', 'on')
  ok('ключ скилла убран, а не записан как "on"', !('code-review' in (read().skillOverrides ?? {})), read().skillOverrides)
  await set('dataviz', 'on')
  ok('пустой раздел уносится целиком', !('skillOverrides' in read()), Object.keys(read()))
  ok('соседние ключи целы', read().model === 'opus' && !!read().hooks, read())

  console.log('\n[5] Мусор вместо состояния не пишется')
  const bad = await set('code-review', 'иногда')
  ok('драйвер отказал', bad?.ok === false, bad)
  ok('и файл не изменился', !('skillOverrides' in read()), read())
  const noName = await set('   ', 'off')
  ok('скилл без имени тоже отказ', noName?.ok === false, noName)

  console.log('\n[6] Настоящий конфиг человека не тронут')
  ok('дом подменён', fakeHome !== realHome, { fakeHome, realHome })
  const realPath = join(realHome, '.claude', 'settings.json')
  const real = existsSync(realPath) ? readFileSync(realPath, 'utf8') : null
  ok(
    'в настоящем settings.json не появилось наших скиллов',
    !real || !/"code-review"|"dataviz"/.test(real),
    real ? real.slice(0, 200) : null
  )

  console.log(`\n[skill-write] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
