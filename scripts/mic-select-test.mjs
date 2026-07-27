/**
 * Выбор микрофона — живая проверка. Реальный микрофон не нужен: Chromium
 * поднимается с синтетическим устройством (--use-fake-device-for-media-stream),
 * поэтому список детерминированный и тест гоняется на любой машине и в CI.
 *
 * Проверяем то, что нельзя проверить юнит-тестом:
 *  1) enumerateDevices вообще отдаёт микрофоны в упакованном рендерере;
 *  2) что РЕАЛЬНО бросает getUserMedia на пропавшем устройстве — от этого
 *     зависит откат в dictation.ts (isDeviceGone);
 *  3) настройка переживает запись и перечитывается из main;
 *  4) вкладка «Голос» показывает список, а пропавшее устройство — отдельной
 *     строкой, а не молчаливым «системный по умолчанию»;
 *  5) правый клик по кнопке микрофона открывает выбор.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-mic-'))
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
  args: [
    join(root, 'out', 'main', 'index.js'),
    // Синтетический микрофон + автоматическое разрешение: иначе на CI нет ни
    // устройства, ни человека, который нажмёт «разрешить».
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream'
  ],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Список устройств доступен рендереру')
  const devices = await page.evaluate(async () => {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }))
  })
  ok('есть хотя бы один audioinput', devices.length > 0, devices)
  const real = devices.filter((d) => d.deviceId && !['default', 'communications'].includes(d.deviceId))
  ok('есть непсевдо-устройство', real.length > 0, devices.map((d) => d.deviceId))
  console.log('    устройства:', JSON.stringify(devices))

  console.log('\n[2] Что бросает getUserMedia на пропавшем устройстве')
  const gone = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: 'нет-такого-устройства' } }
      })
      for (const t of s.getTracks()) t.stop()
      return { threw: false }
    } catch (e) {
      return { threw: true, name: e?.name, message: String(e?.message || '') }
    }
  })
  console.log('    ошибка:', JSON.stringify(gone))
  ok('запрос несуществующего устройства падает, а не берёт молча системное', gone.threw, gone)
  ok(
    'имя ошибки покрыто isDeviceGone (Overconstrained/NotFound/NotReadable)',
    ['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(gone.name),
    gone
  )
  const fallback = await page.evaluate(async () => {
    // Тот же откат, что делает dictation.ts: без deviceId устройство обязано
    // открыться, иначе откат бессмыслен.
    const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    const n = s.getAudioTracks().length
    for (const t of s.getTracks()) t.stop()
    return n
  })
  ok('откат на системное устройство работает', fallback > 0, fallback)

  console.log('\n[3] Настройка сохраняется и переживает перечитывание из main')
  const chosen = real[0]
  await page.evaluate(
    (d) => window.zarya.settings.set({ voice: { deviceId: d.deviceId, deviceLabel: d.label } }),
    chosen
  )
  await page.waitForTimeout(400)
  const saved = await page.evaluate(() => window.__zaryaSettings?.().voice)
  ok('renderer видит выбранное устройство', saved?.deviceId === chosen.deviceId, saved)
  const fromMain = await page.evaluate(async () => (await window.zarya.settings.get()).voice)
  ok('main отдаёт то же самое', fromMain?.deviceId === chosen.deviceId, fromMain)

  console.log('\n[4] Вкладка «Голос»')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(400)
  const navClicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.zy-settings-nav-item')]
    const el = items.find((b) => b.textContent?.includes('Голос'))
    el?.click()
    return !!el
  })
  ok('вкладка «Голос» есть в навигации', navClicked)
  await page.waitForTimeout(400)
  const sel = await page.evaluate(() => {
    const s = document.querySelector('.zy-set-section select.zy-select')
    return s ? { value: s.value, options: [...s.options].map((o) => o.text) } : null
  })
  ok('селект микрофона показывает системное + устройства', (sel?.options.length ?? 0) >= 2, sel)
  ok('выбрано именно сохранённое устройство', sel?.value === chosen.deviceId, sel?.value)
  if (shots) await page.screenshot({ path: join(shots, 'mic-1-settings.png') })

  console.log('\n[5] Пропавшее устройство показано, а не подменено системным')
  await page.evaluate(() =>
    window.zarya.settings.set({
      voice: { deviceId: 'id-которого-нет', deviceLabel: 'Гарнитура Jabra' }
    })
  )
  await page.waitForTimeout(500)
  const missing = await page.evaluate(() => {
    const s = document.querySelector('.zy-set-section select.zy-select')
    return s ? { value: s.value, options: [...s.options].map((o) => o.text) } : null
  })
  ok(
    'в списке появилась строка «не найден»',
    missing?.options.some((t) => t.includes('не найден')),
    missing?.options
  )
  ok('селект НЕ показывает «Системный по умолчанию»', missing?.value === 'id-которого-нет', missing?.value)
  ok(
    'есть кнопка вернуть системный',
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'Вернуть системный')
    )
  )
  if (shots) await page.screenshot({ path: join(shots, 'mic-2-missing.png') })

  console.log('\n[6] Правый клик по кнопке микрофона открывает выбор')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false, barMode: 'claude-code' }))
  await page.waitForTimeout(400)
  const micBtn = await page.$('.zy-agentbar-mic')
  ok('кнопка микрофона на месте', !!micBtn)
  await micBtn?.click({ button: 'right' })
  await page.waitForTimeout(500)
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.zy-context-menu')
    return m ? [...m.querySelectorAll('.zy-context-item')].map((b) => b.textContent) : null
  })
  ok('меню открылось', !!menu, menu)
  ok('в меню есть «Системный по умолчанию»', !!menu?.some((t) => t?.includes('Системный')), menu)
  ok('в меню есть хотя бы одно устройство', (menu?.length ?? 0) >= 2, menu)
  ok(
    'пропавшее устройство показано и в меню',
    !!menu?.some((t) => t?.includes('не найден')),
    menu
  )
  if (shots) await page.screenshot({ path: join(shots, 'mic-3-menu.png') })

  console.log('\n[7] Выбранное устройство помечено галочкой')
  await page.keyboard.press('Escape')
  await page.evaluate(
    (d) => window.zarya.settings.set({ voice: { deviceId: d.deviceId, deviceLabel: d.label } }),
    chosen
  )
  await page.waitForTimeout(400)
  await (await page.$('.zy-agentbar-mic'))?.click({ button: 'right' })
  await page.waitForTimeout(500)
  const checked = await page.evaluate(() => {
    const m = document.querySelector('.zy-context-menu')
    if (!m) return null
    return [...m.querySelectorAll('.zy-context-item')].map((b) => ({
      label: b.querySelector('span')?.textContent,
      hint: b.querySelector('.zy-context-hint')?.textContent
    }))
  })
  const marked = checked?.filter((r) => r.hint === '✓') ?? []
  ok('ровно одна отметка в меню', marked.length === 1, checked)
  ok('отмечено выбранное устройство', marked[0]?.label === chosen.label, marked)
  if (shots) await page.screenshot({ path: join(shots, 'mic-4-checked.png') })

  console.log(`\n[mic-select] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}

/**
 * Отдельный запуск БЕЗ --use-fake-ui-for-media-stream. Флаг авто-разрешения
 * маскирует настоящую политику: названия устройств видны в Заре потому, что
 * main отвечает true на проверку разрешения 'media' (setPermissionCheckHandler),
 * а не потому, что кто-то нажал «разрешить». Сузят скоуп обработчика — список
 * станет безымянным, и без этой проверки регрессия прошла бы незамеченной.
 */
{
  console.log('\n[8] Разрешение выдано нашим обработчиком, а не флагом теста')
  const app2 = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js'), '--use-fake-device-for-media-stream'],
    env: {
      ...process.env,
      ZARYA_USER_DATA: mkdtempSync(join(tmpdir(), 'zarya-mic2-')),
      NODE_ENV: 'production'
    }
  })
  try {
    const p2 = await app2.firstWindow()
    await p2.waitForLoadState('domcontentloaded')
    await p2.waitForTimeout(2500)
    const state = await p2.evaluate(async () => {
      try {
        return (await navigator.permissions.query({ name: 'microphone' })).state
      } catch (e) {
        return 'err:' + e?.name
      }
    })
    ok('permissions.query(microphone) = granted на чистом профиле', state === 'granted', state)
    // ВАЖНО: до какого-либо getUserMedia — иначе проверка ничего не значит.
    const labels = await p2.evaluate(async () =>
      (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput')
        .map((d) => d.label)
    )
    ok('названия видны ДО первого getUserMedia', labels.some((l) => l.trim() !== ''), labels)
  } finally {
    await app2.close()
  }
}

console.log(`\n[mic-select ИТОГ] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
