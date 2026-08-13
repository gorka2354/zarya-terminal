/**
 * Оболочка перечитывает PATH из реестра, а не наследует устаревший.
 *
 *   node scripts/path-refresh-test.mjs
 *
 * Владелец нажал «Перезапустить и повторить» — и получил ту же ошибку. Причина
 * глубже, чем казалось: Windows хранит PATH в реестре, а процесс получает его
 * КОПИЮ от родителя и больше не обновляет. Заря запущена до установки Rust,
 * значит устаревший PATH достаётся всем её оболочкам — и новым панелям, и
 * перезапущенным. Помогал только перезапуск самой Зари.
 *
 * Проверяем ровно это: приложение поднимается с УРЕЗАННЫМ PATH, а оболочка
 * внутри обязана добрать недостающее из реестра. Реестр только читается —
 * ничего в системе не меняется.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  return !!cond
}
const note = (...a) => console.log('   ·', ...a)

if (process.platform !== 'win32') {
  console.log('ПРОПУЩЕНО: проверка про реестр Windows')
  process.exit(2)
}

const ud = mkdtempSync(join(tmpdir(), 'zarya-path-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-pathw-'))
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

/*
 * PATH урезан до одной папки — так выглядит окружение приложения, запущенного
 * ДО установки инструмента. System32 в нём нет намеренно: если он появится в
 * оболочке, значит она сходила в реестр.
 */
const УРЕЗАННЫЙ = 'C:\\Windows'

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    Path: УРЕЗАННЫЙ,
    PATH: УРЕЗАННЫЙ,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const термТекст = (page, sid) =>
  page.evaluate((s) => {
    const t = window.__zaryaTermText?.(s)
    return typeof t === 'string' ? t.replace(/\s+/g, ' ') : ''
  }, sid)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  const sid = await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(3500)
  note('панель:', sid)

  // Спрашиваем саму оболочку, что у неё в PATH.
  const спросить = async (cmd) => {
    await page.evaluate(([s, c]) => window.zarya.pty.write(s, c + '\r'), [sid, cmd])
    await page.waitForTimeout(3000)
    return термТекст(page, sid)
  }

  console.log('\n[1] Оболочка добрала PATH из реестра')
  const ответ = await спросить(
    'if ($env:Path -like "*System32*") { "PATH-ОБНОВЛЁН" } else { "PATH-СТАРЫЙ" }'
  )
  note('ответ оболочки:', JSON.stringify(ответ.slice(-90)))
  ok('в PATH появилось то, чего не дал родитель', /PATH-ОБНОВЛЁН/.test(ответ), ответ.slice(-120))

  console.log('\n[2] Унаследованное не потеряно')
  const ответ2 = await спросить(
    'if ($env:Path -like "*C:\\Windows*") { "РОДИТЕЛЬСКОЕ-НА-МЕСТЕ" } else { "ПОТЕРЯЛИ" }'
  )
  // Реестр перевешивает, но то, что дали Заре при запуске, обязано остаться:
  // иначе мы чиним один случай и ломаем окружение из-под nvm или своей оболочки.
  ok('папка от родителя осталась', /РОДИТЕЛЬСКОЕ-НА-МЕСТЕ/.test(ответ2), ответ2.slice(-120))

  console.log('\n[3] Дубликатов в PATH не появилось')
  const ответ3 = await спросить(
    '$p=$env:Path.Split(";")|?{$_};$u=$p|%{$_.TrimEnd("\\").ToLower()}|Select -Unique;' +
      'if ($p.Count -eq $u.Count) { "БЕЗ-ДУБЛЕЙ" } else { "ЕСТЬ-ДУБЛИ: " + ($p.Count - $u.Count) }'
  )
  note('дубли:', JSON.stringify(ответ3.slice(-70)))
  // Склеивая реестр и унаследованное, легко получить PATH в три экрана — он
  // замедляет запуск каждой программы и мешает читать его глазами.
  ok('дублей нет', /БЕЗ-ДУБЛЕЙ/.test(ответ3), ответ3.slice(-120))
} finally {
  await app.close()
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка */
    }
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
