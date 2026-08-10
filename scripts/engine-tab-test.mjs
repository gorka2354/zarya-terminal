/**
 * Вкладка «Движок» и правка памяти (inc-29) — на живом окне.
 *
 * Когда Claude Code сломан, сломанной выглядит Заря: два разных `claude`, вход
 * не тем аккаунтом, битая запятая в чужом `settings.json` — снаружи всё
 * одинаково. Проверяем, что экран отвечает на три вопроса: какой файл
 * работает, кто вошёл и что движок говорит о себе.
 *
 * Отдельно — главное про отчёт движка: он внутренне противоречив (печатает
 * находку и следом «проблем нет»), и Заря обязана показать его ДОСЛОВНО, не
 * сводя в свой вердикт.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-eng-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-eng-work-'))
// Файл памяти, который прогон будет править. Фейковый драйвер называет свои
// пути в снимке — подменяем один на настоящий, чтобы правка была настоящей.
const memFile = join(work, 'CLAUDE.md')
writeFileSync(memFile, 'старое правило\n')

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

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    // Фейковый снимок памяти должен указывать на НАСТОЯЩИЙ файл: иначе правка
    // проверяла бы только показ, а не запись.
    ZARYA_FAKE_MEMORY_FILE: memFile,
    NODE_ENV: 'production'
  }
})

const openTab = async (page, tab) => {
  await page.evaluate((t) => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: t }), tab)
  await page.waitForTimeout(900)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  // Беседа нужна обеим вкладкам: и «Движок», и «Инструменты» показывают
  // состояние КОНКРЕТНОЙ панели, а не приложения вообще.
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'просто ответь'))
  await page.waitForTimeout(1600)

  console.log('\n[1] Видно, какой файл движка работает и почему')
  await openTab(page, 'engine')
  const bins = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-eng-bin')).map((el) => ({
      chosen: el.className.includes('--chosen'),
      origin: el.querySelector('.zy-eng-origin')?.textContent ?? '',
      ver: el.querySelector('.zy-eng-ver')?.textContent ?? '',
      path: el.querySelector('.zy-eng-path')?.textContent ?? '',
      why: el.querySelector('.zy-eng-why')?.textContent ?? ''
    }))
  )
  ok('найдено больше одного файла', bins.length >= 2, bins.length)
  const chosen = bins.filter((b) => b.chosen)
  ok('выбранный ровно один', chosen.length === 1, bins)
  ok('у него названа версия', /9\.9\.9/.test(chosen[0]?.ver ?? ''), chosen[0])
  ok('и путь целиком', /fake\/system\/claude/.test(chosen[0]?.path ?? ''), chosen[0])
  ok('сказано, ПОЧЕМУ он', /новее/i.test(chosen[0]?.why ?? ''), chosen[0]?.why)
  ok('остальные тоже показаны', bins.some((b) => !b.chosen && b.path), bins)

  console.log('\n[2] Видно, кто вошёл')
  const auth = await page.evaluate(
    () => document.querySelector('.zy-eng-auth')?.textContent ?? ''
  )
  ok('вход назван', /вход есть/i.test(auth), auth)
  ok('и аккаунт тоже', /qa@example\.test/.test(auth), auth)

  console.log('\n[3] Обновление: команда есть, кнопки «обновить» нет')
  const cmd = await page.evaluate(() => document.querySelector('.zy-eng-cmd')?.textContent ?? '')
  ok('команда показана', cmd.trim() === 'claude update', cmd)
  const why = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-eng-note'))
      .map((e) => e.textContent ?? '')
      .join(' | ')
  )
  ok('сказано, почему Заря не обновляет сама', /не обновляет движок сама/i.test(why), why)
  if (shots) await page.screenshot({ path: join(shots, 'engine-tab.png') })

  console.log('\n[4] Отчёт движка — дословно, без нашего вердикта поверх')
  const before = await page.evaluate(() => !!document.querySelector('.zy-eng-report'))
  ok('до нажатия отчёта нет — процесс сам не запускается', before === false)
  await page.click('.zy-eng-btn:not([disabled])', { timeout: 5000 }).catch(() => {})
  // Кнопок с этим классом две (копировать и спросить) — жмём именно «спросить».
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.zy-eng-btn'))
    const ask = btns.find((b) => /спросить/i.test(b.textContent ?? ''))
    ask?.click()
  })
  await page.waitForTimeout(1500)
  const report = await page.evaluate(
    () => document.querySelector('.zy-eng-report')?.textContent ?? ''
  )
  ok('отчёт появился', report.length > 0, report.slice(0, 80))
  ok('находка движка на месте', /Invalid settings/.test(report), report.slice(0, 200))
  ok('и его противоречивая строка тоже — мы её не прячем', /No installation issues/.test(report))
  const verdict = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-eng-empty'))
      .map((e) => e.textContent ?? '')
      .join(' | ')
  )
  ok('своего вердикта «всё в порядке» Заря не ставит', !/в порядке|проблем нет/i.test(verdict), verdict)
  if (shots) await page.screenshot({ path: join(shots, 'engine-doctor.png') })

  console.log('\n[5] Приписка к системному промпту сохраняется')
  /*
   * Печатаем и уходим фокусом ПО-НАСТОЯЩЕМУ.
   *
   * Синтетический `blur` из `evaluate` до React не доходит: он не всплывает, а
   * React слушает его перехватом на корне. Прогон, который «нажал» так, проверил
   * бы собственную подделку события, а не поле.
   */
  await page.locator('.zy-settings-content-body textarea').last().fill('отвечай кратко')
  await page.locator('.zy-settings-content-body').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(900)
  const saved = await page.evaluate(() => window.__zaryaSettings?.()?.ai?.enginePromptExtra ?? '')
  ok('приписка легла в настройки', /отвечай кратко/.test(saved), saved)

  console.log('\n[6] Файл памяти можно поправить прямо там, где видна его цена')
  await openTab(page, 'tools')
  // Разбор контекста свёрнут — раскрываем.
  await page.evaluate(() => document.querySelector('.zy-ctx-head')?.click())
  await page.waitForTimeout(500)
  const kinds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-mem-kind')).map((e) => e.textContent ?? '')
  )
  ok('уровень файла подписан', kinds.length >= 1, kinds)
  const managedHasNoEdit = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.zy-ctx-row--file'))
    const managed = rows.find((r) => /managed/i.test(r.querySelector('.zy-mem-kind')?.textContent ?? ''))
    return managed ? !managed.querySelector('.zy-mem-edit') : 'нет managed-строки'
  })
  ok('у политики организации кнопки правки нет', managedHasNoEdit === true, managedHasNoEdit)

  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.zy-ctx-row--file'))
    // Именно ПРОЕКТНЫЙ файл: личный в фейке указывает на несуществующий путь,
    // и щелчок по нему проверял бы отказ, а не правку.
    const row = rows.find((r) => /eng-work/i.test(r.querySelector('.zy-ctx-name')?.textContent ?? ''))
    row?.querySelector('.zy-mem-edit')?.click()
  })
  await page.waitForTimeout(900)
  const area = await page.evaluate(
    () => document.querySelector('.zy-mem-area')?.value ?? null
  )
  ok('редактор открылся с содержимым файла', /старое правило/.test(area ?? ''), area)

  await page.evaluate(() => {
    const ta = document.querySelector('.zy-mem-area')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, 'старое правило\nновое правило')
    ta?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  const dirty = await page.evaluate(
    () => document.querySelector('.zy-mem-dirty')?.textContent ?? ''
  )
  ok('несохранённое названо словом', /несохран/i.test(dirty), dirty)
  await page.evaluate(() => document.querySelector('.zy-mem-save')?.click())
  await page.waitForTimeout(900)
  const onDisk = readFileSync(memFile, 'utf8')
  ok('правка легла В ФАЙЛ, а не только на экран', /новое правило/.test(onDisk), onDisk)
  ok('старое при этом не потеряно', /старое правило/.test(onDisk), onDisk)
  const memNote = await page.evaluate(
    () => document.querySelector('.zy-mem-note')?.textContent ?? ''
  )
  ok('и сказано, что цена в токенах теперь другая', /токен/i.test(memNote), memNote)
  if (shots) await page.screenshot({ path: join(shots, 'engine-memory.png') })

  console.log('\n[7] Чужую правку не затираем: файл изменился на диске')
  /*
   * Пока редактор открыт, файл мог поправить сам агент (жест «#»), соседняя
   * панель или человек сторонним редактором. Записать поверх — уничтожить
   * чужую работу, просто с задержкой. Расхождение не решаем за человека:
   * говорим и НЕ пишем.
   */
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.zy-ctx-row--file'))
    const row = rows.find((r) => /eng-work/i.test(r.querySelector('.zy-ctx-name')?.textContent ?? ''))
    // Редактор ещё открыт с прошлого шага — закрываем и открываем заново, чтобы
    // «снимок при открытии» был свежим.
    row?.querySelector('.zy-mem-edit')?.click()
  })
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.zy-ctx-row--file'))
    const row = rows.find((r) => /eng-work/i.test(r.querySelector('.zy-ctx-name')?.textContent ?? ''))
    row?.querySelector('.zy-mem-edit')?.click()
  })
  await page.waitForTimeout(700)
  // Кто-то другой пишет в файл прямо сейчас.
  writeFileSync(memFile, 'правка со стороны\n')
  await page.locator('.zy-mem-area').fill('моя правка из окна')
  await page.waitForTimeout(200)
  await page.evaluate(() => document.querySelector('.zy-mem-save')?.click())
  await page.waitForTimeout(800)
  const clash = await page.evaluate(
    () => document.querySelector('.zy-mem-note')?.textContent ?? ''
  )
  ok('сказано, что файл изменился снаружи', /изменился на диске/i.test(clash), clash)
  const kept = readFileSync(memFile, 'utf8')
  ok('чужая правка НЕ затёрта', /правка со стороны/.test(kept), kept)
  ok('и наша не записана молча', !/моя правка из окна/.test(kept), kept)

  console.log(`\n[engine-tab] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
