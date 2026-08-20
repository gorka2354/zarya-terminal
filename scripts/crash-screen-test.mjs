/**
 * Сорванная отрисовка не оставляет человека перед пустым окном.
 *
 *   node scripts/crash-screen-test.mjs
 *
 * ПОВОД, И ОН НЕ ГИПОТЕТИЧЕСКИЙ. В inc-48 сторож мёртвых нажатий нашёл
 * действие «Панель блоков», которое роняло React ошибкой #185: дерево
 * снималось целиком, окно становилось ПУСТЫМ, и вернуть его можно было только
 * перезапуском. Ни строки на экране, ни файла на диске — человек видел белый
 * прямоугольник и не мог даже сказать, что произошло.
 *
 * Здесь проверяется то, что теперь есть вместо пустоты: экран с дословным
 * текстом ошибки, тремя понятными кнопками и записью в журнал на этой машине.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

const ud = mkdtempSync(join(tmpdir(), 'zarya-crash-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-crash-w-'))
writeFileSync(join(ud, 'settings.json'), JSON.stringify({ appearance: { language: 'ru' } }))

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

const logText = () => {
  const dir = join(ud, 'logs')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .map((f) => {
      try {
        return readFileSync(join(dir, f), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1500)

  console.log('\n[1] Необработанная ошибка окна попадает в журнал')
  /*
   * Ошибку ВНЕ отрисовки React не ловит: она уходит в консоль, которой человек
   * не видит, и остаётся только «оно как-то странно себя ведёт».
   */
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('прогон: необработанная ошибка окна')
    }, 0)
  })
  await page.waitForTimeout(800)
  const afterThrow = logText()
  note('в журнале:', JSON.stringify(afterThrow.slice(-160)))
  ok('запись появилась', afterThrow.includes('необработанная ошибка окна'), afterThrow.slice(-200))
  ok('и она подписана версией и временем', /=== \d{4}-\d\d-\d\dT.*Zarya /.test(afterThrow), afterThrow.slice(0, 120))

  console.log('\n[2] Отказ обещания — тоже')
  await page.evaluate(() => {
    void Promise.reject(new Error('прогон: отказ обещания'))
  })
  await page.waitForTimeout(800)
  ok('запись появилась', logText().includes('отказ обещания'), logText().slice(-200))

  console.log('\n[3] Сорванная отрисовка показывает экран, а не пустоту')
  /*
   * Роняем ровно так, как это делает настоящий дефект: ошибкой ВНУТРИ
   * отрисовки. Для этого просим ленту нарисовать сообщение с частью, которой
   * не бывает, — компонент сорвётся на ней при следующем кадре.
   */
  const before = await page.evaluate(() => document.querySelectorAll('.zy-pane').length)
  ok('до аварии панель на месте', before > 0, before)
  await page.evaluate(() => window.__zaryaCrashRender?.())
  await page.waitForTimeout(1200)
  const screen = await page.evaluate(() => ({
    crash: !!document.querySelector('.zy-crash'),
    title: document.querySelector('.zy-crash-title')?.textContent ?? '',
    what: document.querySelector('.zy-crash-what')?.textContent ?? '',
    buttons: [...document.querySelectorAll('.zy-crash-actions .zy-btn')].map(
      (b) => b.textContent ?? ''
    ),
    root: document.querySelector('#root')?.children.length ?? 0
  }))
  note('экран аварии:', JSON.stringify(screen))
  ok('окно НЕ пустое', screen.root > 0, screen)
  ok('показан экран аварии', screen.crash === true, screen)
  ok('текст ошибки — дословно', /прогон: срыв отрисовки/.test(screen.what), screen.what)
  ok('и три кнопки: перезагрузить, скопировать, журнал', screen.buttons.length === 3, screen.buttons)

  console.log('\n[4] И эта авария тоже записана')
  const afterCrash = logText()
  note('в журнале:', JSON.stringify(afterCrash.slice(-200)))
  ok('запись появилась', afterCrash.includes('срыв отрисовки'), afterCrash.slice(-200))
  ok(
    'со стеком компонентов — видно, какой кусок интерфейса сорвался',
    /at \w+/.test(afterCrash),
    afterCrash.slice(-300)
  )
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  for (const d of [ud, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка останется — не повод падать */
    }
  }
}

console.log(`\n[crash-screen] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
