/**
 * `zarya .` — запуск из папки (inc-30), на живом окне.
 *
 * Терминал, который сам запускается только мышью, — странный терминал. Из
 * проводника, из скрипта, из другого терминала — все три пути упираются в одно:
 * передать папку при запуске.
 *
 * Проверяется настоящий путь целиком: аргумент → главный процесс → окно →
 * открытая вкладка с ЭТОЙ папкой. И отдельно — отказ: несуществующий путь
 * обязан сказать о себе, а не молча открыть что-то другое.
 */
import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
/*
 * Путь к самому Electron. `process.execPath` здесь — это node, и запуск главного
 * бандла под ним падает на первой же строке: второй экземпляр «не сработал» бы
 * по причине, не имеющей отношения к проверяемому.
 */
const electronExe = createRequire(import.meta.url)('electron')
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

const dirs = []
const launch = (args, extraEnv = {}) => {
  const userData = mkdtempSync(join(tmpdir(), 'zarya-cli-'))
  dirs.push(userData)
  return electron.launch({
    // Собранное приложение получает папку ПЕРВЫМ аргументом, запуск из
    // исходников — вторым (первый там сама Заря). Прогон идёт вторым путём,
    // как и вся остальная проверка.
    args: [join(root, 'out', 'main', 'index.js'), ...args],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: userData,
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production',
      ...extraEnv
    }
  })
}

/** Пути сравниваем без учёта регистра и вида разделителя: Windows. */
const norm = (p) => String(p ?? '').split('\\').join('/').toLowerCase()

const state = (page) =>
  page.evaluate(() => {
    const s = window.__zaryaDumpSessions?.()
    return {
      cwds: (s?.sessions ?? []).map((x) => x.cwd),
      tabs: (s?.tabs ?? []).length
    }
  })

const work = mkdtempSync(join(tmpdir(), 'zarya-cli-proj-'))
dirs.push(work)

let app = null
try {
  console.log('\n[1] Папка из командной строки открывается вкладкой')
  app = await launch([work])
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(5000)
  let st = await state(page)
  console.log('  папки панелей:', JSON.stringify(st.cwds))
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase()
  ok('панель с этой папкой открылась', st.cwds.some((c) => norm(c) === norm(work)), {
    want: work,
    got: st.cwds
  })
  // Папка запомнена в проектах — тем же путём, что и «открыть папку» мышью.
  const projects = await page.evaluate(() => window.__zaryaSettings?.()?.bookmarks ?? [])
  ok('и попала в список проектов', projects.some((p) => norm(p) === norm(work)), projects)
  if (shots) await page.screenshot({ path: join(shots, 'cli-open.png') })
  await app.close()
  app = null

  console.log('\n[2] Несуществующий путь говорит о себе, а не молчит')
  const ghost = join(work, 'нет-такой-папки')
  app = await launch([ghost])
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(5000)
  const toast = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-toast, [class*="toast"]'))
      .map((e) => e.textContent ?? '')
      .join(' | ')
  )
  ok('сказано, что открыть нечем', /открыть нечем/i.test(toast), toast)
  ok('и назван сам путь', /нет-такой-папки/.test(toast), toast)
  st = await state(page)
  ok(
    'при этом чужая папка НЕ открылась вместо неё',
    !st.cwds.some((c) => norm(c) === norm(ghost)),
    st.cwds
  )
  await app.close()
  app = null

  console.log('\n[3] Заря уже открыта: папка приезжает В НЕЁ, второго окна нет')
  /*
   * Самый частый путь `zarya .` — не первый запуск, а второй: приложение уже
   * работает. Раньше второй экземпляр просто будил окно и молча забывал, зачем
   * его звали.
   *
   * Прогону нужен настоящий замок единственного экземпляра, которого у
   * изолированного запуска нет, — отсюда `ZARYA_SINGLE_INSTANCE`. Оба запуска
   * идут с ОДНИМ userData: иначе замок у каждого будет свой, и второй просто
   * поднимет второе приложение.
   */
  const shared = mkdtempSync(join(tmpdir(), 'zarya-cli-2nd-'))
  dirs.push(shared)
  const second = mkdtempSync(join(tmpdir(), 'zarya-cli-proj2-'))
  dirs.push(second)
  app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: shared,
      ZARYA_SINGLE_INSTANCE: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(4500)
  const before = (await state(page)).cwds.length

  // Второй экземпляр: обычный дочерний процесс, как если бы человек набрал
  // `zarya <папка>` в другом терминале. Он должен ЗАВЕРШИТЬСЯ сам, отдав папку.
  const child = spawnSync(
    electronExe,
    [join(root, 'out', 'main', 'index.js'), second],
    {
      env: {
        ...process.env,
        ZARYA_USER_DATA: shared,
        ZARYA_SINGLE_INSTANCE: '1',
        ZARYA_NO_UPDATE_CHECK: '1',
        ZARYA_NO_ONBOARDING: '1',
        NODE_ENV: 'production'
      },
      timeout: 30_000,
      encoding: 'utf8'
    }
  )
  ok('второй экземпляр завершился сам, а не поднял окно', child.status === 0, {
    status: child.status,
    err: String(child.stderr ?? '').slice(0, 200)
  })
  await page.waitForTimeout(3500)
  st = await state(page)
  ok(
    'папка второго запуска открылась в УЖЕ ОТКРЫТОЙ Заре',
    st.cwds.some((c) => norm(c) === norm(second)),
    { want: second, got: st.cwds }
  )
  ok('и это новая панель, а не подмена прежней', st.cwds.length > before, {
    before,
    after: st.cwds.length
  })
  if (shots) await page.screenshot({ path: join(shots, 'cli-open-second.png') })
  await app.close()
  app = null

  console.log('\n[4] Запуск без аргументов ничего не открывает лишнего')
  app = await launch([])
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(4000)
  const quiet = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-toast, [class*="toast"]'))
      .map((e) => e.textContent ?? '')
      .join(' | ')
  )
  ok('ни жалоб, ни лишних окон', !/открыть нечем/i.test(quiet), quiet)

  console.log(`\n[cli-open] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  if (app) await app.close()
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // временная папка не удалилась — не повод ронять прогон
    }
  }
}
process.exit(fail ? 1 : 0)
