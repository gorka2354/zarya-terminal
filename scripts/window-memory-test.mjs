/**
 * Окно помнит, каким его оставили.
 *
 *   node scripts/window-memory-test.mjs
 *
 * ПОВОД. Заря помнит сессии, блоки, разговоры, раскладку панелей, вкладки, шрифт
 * и тему — всё, кроме самого окна: каждый запуск открывал одни и те же 1360×860
 * посреди экрана, сколько бы человек его вчера ни растягивал.
 *
 * ⚠️ ПОСЛЕДНЯЯ ЧАСТЬ ПОКАЗЫВАЕТ ОКНО. Тихий прогон уводит окно за край экрана —
 * а окно за краем экрана Заря намеренно НЕ запоминает (см. windowState.ts:
 * прямоугольник, до которого не дотянуться, не должен становиться настройкой).
 * Значит круг «подвинул → закрыл → открыл» иначе не проверить: он проверяется
 * ровно тем окном, которое видит человек. Секунд пятнадцать, один раз.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const MAIN = join(process.cwd(), 'out', 'main', 'index.js')
const baseEnv = {
  ...process.env,
  ZARYA_FAKE_AGENT: '1',
  ZARYA_NO_UPDATE_CHECK: '1',
  ZARYA_NO_ONBOARDING: '1',
  NODE_ENV: 'production'
}

const launch = (ud, { visible = false } = {}) =>
  electron.launch({
    args: [MAIN],
    env: {
      ...baseEnv,
      ...(visible ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: ud
    }
  })

const bounds = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { ...w.getNormalBounds(), maximized: w.isMaximized() }
  })

const stateFile = (ud) => join(ud, 'window.json')
const readState = (ud) => {
  try {
    return JSON.parse(readFileSync(stateFile(ud), 'utf8'))
  } catch {
    return null
  }
}

const dirs = []
const fresh = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `zarya-win-${tag}-`))
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ appearance: { language: 'ru' } }))
  dirs.push(d)
  return d
}

try {
  console.log('\n[1] Сохранённый размер достаётся окну при запуске')
  {
    const ud = fresh('restore')
    writeFileSync(stateFile(ud), JSON.stringify({ x: 120, y: 90, width: 1180, height: 720 }))
    const app = await launch(ud)
    await app.firstWindow()
    const b = await bounds(app)
    note('окно открылось:', JSON.stringify(b))
    ok('ширина — та, что записана', b.width === 1180, b)
    ok('высота — та, что записана', b.height === 720, b)
    await app.close().catch(() => {})
  }

  console.log('\n[2] Прямоугольник с отключённого монитора отбрасывается')
  {
    /*
     * Ради этого правило и заведено: вчерашнее положение легко оказывается там,
     * где экрана больше нет, и восстановить его вслепую значит открыть окно,
     * которого не видно, — со стороны это «программа не запустилась».
     * Размер при этом помним: «окно было широким» — привычка человека, а не
     * свойство исчезнувшего монитора.
     */
    const ud = fresh('offscreen')
    writeFileSync(stateFile(ud), JSON.stringify({ x: -9000, y: -9000, width: 1180, height: 720 }))
    const app = await launch(ud)
    await app.firstWindow()
    const b = await bounds(app)
    note('окно открылось:', JSON.stringify(b))
    ok('в недосягаемое место окно НЕ поставлено', b.x > -3000 && b.y > -3000, b)
    ok('а размер всё равно помним', b.width === 1180 && b.height === 720, b)
    await app.close().catch(() => {})
  }

  console.log('\n[3] Развёрнутым закрыли — развёрнутым и открылось')
  {
    const ud = fresh('max')
    writeFileSync(
      stateFile(ud),
      JSON.stringify({ x: 100, y: 100, width: 1180, height: 720, maximized: true })
    )
    const app = await launch(ud)
    await app.firstWindow()
    const b = await bounds(app)
    note('окно открылось:', JSON.stringify(b))
    ok('окно развёрнуто', b.maximized === true, b)
    ok('и размер «до разворота» не потерян', b.width === 1180 && b.height === 720, b)
    await app.close().catch(() => {})
  }

  console.log('\n[4] Испорченный файл не мешает запуску')
  {
    const ud = fresh('junk')
    writeFileSync(stateFile(ud), '{ это не json')
    const app = await launch(ud)
    await app.firstWindow()
    const b = await bounds(app)
    note('окно открылось:', JSON.stringify(b))
    ok('открылись размером по умолчанию', b.width === 1360 && b.height === 860, b)
    await app.close().catch(() => {})
  }

  console.log('\n[5] Прогон за краем экрана НЕ подменяет настройку человека')
  {
    /*
     * Тихий прогон уводит окно на -32000 и задаёт свои размеры. Записав это, мы
     * при следующем запуске вернули бы человеку окно, которого он не видит.
     */
    const ud = fresh('qa')
    const app = await launch(ud)
    const page = await app.firstWindow()
    await page.waitForTimeout(2500)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
    await page.waitForTimeout(1500)
    await app.close().catch(() => {})
    const saved = readState(ud)
    note('window.json:', JSON.stringify(saved))
    ok('файла нет вовсе', !existsSync(stateFile(ud)), saved)
  }

  console.log('\n[6] Круг целиком: подвинул → закрыл → открыл (ОКНО БУДЕТ ВИДНО)')
  {
    const ud = fresh('roundtrip')
    const target = { x: 70, y: 70, width: 1104, height: 702 }
    const app = await launch(ud, { visible: true })
    const page = await app.firstWindow()
    await page.waitForTimeout(2500)
    await app.evaluate(({ BrowserWindow }, b) => {
      BrowserWindow.getAllWindows()[0].setBounds(b)
    }, target)
    await page.waitForTimeout(1200)
    await app.close().catch(() => {})

    const saved = readState(ud)
    note('записано:', JSON.stringify(saved))
    ok('положение записано', saved?.x === target.x && saved?.y === target.y, saved)
    ok('размер записан', saved?.width === target.width && saved?.height === target.height, saved)

    const again = await launch(ud, { visible: true })
    await again.firstWindow()
    const b = await bounds(again)
    note('открылось:', JSON.stringify(b))
    ok(
      'окно вернулось туда же и тем же',
      b.x === target.x &&
        b.y === target.y &&
        b.width === target.width &&
        b.height === target.height,
      b
    )
    await again.close().catch(() => {})
  }
} catch (e) {
  ok('ПРОГОН УПАЛ', false, e?.message || String(e))
} finally {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка останется — не повод падать */
    }
  }
}

console.log(`\n[window-memory] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
