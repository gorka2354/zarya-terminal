/**
 * Картинка из инструмента (inc-27) — на живом окне.
 *
 * MCP-сервер, вернувший скриншот, раньше был в Заре нем: блок `image` драйвер
 * выбрасывал, и карточка вызова, вся суть которого — картинка, оставалась
 * пустой. Проверяем и обратную сторону: байтов картинки в СОХРАНЁННОЙ беседе
 * быть не должно, иначе файл беседы растёт без предела.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-img-'))
let pass = 0,
  fail = 0,
  closed = false
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
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'картинка с отказом'))
  await page.waitForTimeout(2200)

  console.log('\n[1] Картинка на карточке, а не пустая карточка')
  const img = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-tool-imgs img')
    if (!el) return null
    return {
      src: (el.getAttribute('src') ?? '').slice(0, 24),
      alt: el.getAttribute('alt') ?? '',
      w: el.naturalWidth,
      h: el.naturalHeight
    }
  })
  ok('картинка есть в карточке', !!img, img)
  ok('это данные, а не ссылка наружу', /^data:image\/png;base64/.test(img?.src ?? ''), img?.src)
  ok('и она правда декодировалась', img?.w === 96 && img?.h === 48, img)
  ok('у неё есть подпись для чтения с экрана', /картинк/i.test(img?.alt ?? ''), img?.alt)

  const cap = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-imgs figcaption')?.textContent ?? ''
  )
  ok('размер назван', /КБ|МБ/.test(cap), cap)

  console.log('\n[2] О непоказанной картинке сказано, а не умолчено')
  const skipped = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-imgs-gone')?.textContent ?? ''
  )
  ok('строка об отклонённой картинке есть', /не показано/i.test(skipped), skipped)

  console.log('\n[3] Текст результата при этом никуда не делся')
  const outcome = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-done, .zy-mf-outcome-text')?.textContent ?? ''
  )
  ok('итог вызова читается', /снимок сделан/.test(outcome), outcome)
  if (shots) await page.screenshot({ path: join(shots, 'tool-image.png') })

  console.log('\n[4] В файл беседы байты картинки НЕ уходят')
  // Смотрим НАСТОЯЩИЙ файл, а не то, что лежит в памяти: обещание «на диск не
  // попадает» проверяется только диском. Беседа сбрасывается при выходе, поэтому
  // приложение закрываем здесь, а не в finally.
  await app.close()
  closed = true
  await new Promise((r) => setTimeout(r, 800))
  const file = join(userData, 'ai-conversations.json')
  ok('файл беседы существует', existsSync(file), file)
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
  ok('байтов картинки в файле нет', !raw.includes('iVBORw0KGgo'), raw.length)
  ok('но число картинок сохранено', /"images":\s*1/.test(raw), raw.slice(0, 200))
  // Столько же — верхняя граница здравого смысла: без картинок беседа мала.
  ok('файл остался маленьким', raw.length < 40_000, raw.length)

  console.log('\n[5] После перезапуска карточка говорит правду, а не молчит')
  // Самое важное следствие решения «не сохраняем»: восстановленная карточка
  // обязана объяснить пустое место, иначе она читается как «инструмент ничего
  // не вернул» — то есть врёт ровно так же, как молчала до inc-27.
  const again = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: userData,
      ZARYA_FAKE_AGENT: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    }
  })
  try {
    const p2 = await again.firstWindow()
    await p2.waitForLoadState('domcontentloaded')
    await p2.waitForTimeout(3500)
    const state = await p2.evaluate(() => ({
      img: !!document.querySelector('.zy-mf-tool-imgs img'),
      gone: document.querySelector('.zy-mf-tool-imgs-gone')?.textContent ?? ''
    }))
    ok('картинки больше нет — как и обещано', state.img === false, state)
    ok('и об этом сказано числом', /картинок от инструмента: 1/.test(state.gone), state.gone)
    ok('с объяснением, почему её нет', /не сохран/i.test(state.gone), state.gone)
    if (shots) await p2.screenshot({ path: join(shots, 'tool-image-restored.png') })
  } finally {
    await again.close()
  }

  console.log(`\n[tool-image] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  if (!closed) await app.close()
}
process.exit(fail ? 1 : 0)
