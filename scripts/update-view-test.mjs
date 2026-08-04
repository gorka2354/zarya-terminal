/**
 * Страница «Что нового» — живая проверка.
 *
 * Сеть не трогается: состояние подставляется в стор рендерера. Проверяется то,
 * ради чего эта страница вообще опасна — в приложение приезжает контент из сети
 * и превращается в кнопку, на которую человек нажмёт, потому что её показала
 * Заря. Поэтому главные утверждения тут не про вёрстку:
 *
 *   1) адрес скачивания собирает САМО приложение из константы репозитория;
 *   2) враждебный тег или имя файла кнопку не дают вовсе;
 *   3) разметка из тела релиза не приносит на страницу скрипт.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-upd-'))
// Автопроверки выключены: состояние релиза прогон задаёт сам, а живой ответ
// GitHub приходил бы поверх и гасил экран, который мы проверяем. Само правило
// «когда переспрашивать» проверяется юнитами (shouldRecheck).
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, updates: { check: false } })
)
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

const GOOD = {
  current: '0.5.1',
  updateAvailable: true,
  checking: false,
  checkedAt: 1,
  latest: {
    version: '0.5.2',
    tag: 'v0.5.2',
    name: 'Zarya 0.5.2 «Голос»',
    body: '## Что нового\n\n- Выбор микрофона\n- Волна субагентов\n\n**Важно:** Esc теперь как в CLI.',
    publishedAt: '2026-07-27T10:00:00Z',
    assets: [
      { name: 'Zarya-Setup-0.5.2-win-x64.exe', size: 188_000_000 },
      { name: 'SHA256SUMS-0.5.2.txt', size: 200 }
    ],
    sums: {
      'Zarya-Setup-0.5.2-win-x64.exe':
        'f86ebfa0429ced91be6054fc344827e9c6c2572f3c318416cd974b06f66437ec'
    }
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  // Без похода в сеть: состояние релиза прогон задаёт сам, а живой ответ
  // GitHub приходил бы поверх и гасил экран, который мы проверяем.
  env: {
    ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Индикатор появляется только когда есть что предлагать')
  ok('без обновления кнопки нет', !(await page.$('.zy-activity-upd')))
  await page.evaluate((s) => window.__zaryaSetUpdate?.(s), GOOD)
  await page.waitForTimeout(300)
  ok('с обновлением кнопка есть', !!(await page.$('.zy-activity-upd')))

  console.log('\n[2] Страница показывает то, ради чего её открыли')
  await page.click('.zy-activity-upd')
  await page.waitForTimeout(400)
  const text = await page.evaluate(() => document.querySelector('.zy-upd')?.textContent ?? '')
  ok('заголовок релиза', text.includes('Zarya 0.5.2'), text.slice(0, 80))
  ok('переход версий «у вас → новая»', text.includes('0.5.1') && text.includes('0.5.2'))
  ok('changelog отрисован', text.includes('Выбор микрофона') && text.includes('Волна субагентов'))
  ok('файл со сборкой в списке', text.includes('Zarya-Setup-0.5.2-win-x64.exe'))
  ok('SHA256 показан целиком', text.includes('f86ebfa0429ced91be6054fc344827e9c6c2572f3c318416cd974b06f66437ec'))
  ok('файл контрольных сумм не предлагается к скачиванию', !text.includes('SHA256SUMS-0.5.2.txt'))
  const md = await page.evaluate(() => document.querySelector('.zy-upd-notes')?.innerHTML ?? '')
  ok('markdown стал разметкой, а не текстом', /<li>/.test(md) && /<strong>/.test(md), md.slice(0, 100))
  if (shots) await page.screenshot({ path: join(shots, 'upd-1-page.png') })

  console.log('\n[3] Адрес скачивания строит приложение, а не ответ сервера')
  // Читаем адрес из data-url: window.zarya за contextBridge доступен только на
  // чтение, подменить openExternal со страницы нельзя. Атрибут и обработчик
  // берут ОДНУ переменную, так что проверка атрибута проверяет и нажатие.
  const urls = await page.evaluate(() => ({
    file: document.querySelector('.zy-upd-file button')?.dataset.url,
    page: [...document.querySelectorAll('.zy-upd-foot button')]
      .map((b) => b.dataset.url)
      .filter(Boolean)[0]
  }))
  ok(
    'файл ведёт в наш релиз на GitHub',
    urls.file ===
      'https://github.com/gorka2354/zarya-terminal/releases/download/v0.5.2/Zarya-Setup-0.5.2-win-x64.exe',
    urls
  )
  ok(
    'страница релиза — тоже наш адрес',
    urls.page === 'https://github.com/gorka2354/zarya-terminal/releases/tag/v0.5.2',
    urls
  )
  // Кнопка честно показывает, куда ведёт, ещё до нажатия.
  const title = await page.evaluate(
    () => document.querySelector('.zy-upd-file button')?.getAttribute('title') ?? ''
  )
  ok('адрес виден в подсказке до нажатия', title.includes('github.com/gorka2354'), title)

  console.log('\n[4] Враждебный релиз кнопку не даёт')
  // Такое не пройдёт parseRelease в main — здесь проверяется второй рубеж:
  // страница обязана отказаться строить ссылку сама, даже если состояние
  // подсунули напрямую.
  await page.evaluate(() => {
    window.__zaryaSetUpdate?.({
      current: '0.5.1',
      updateAvailable: true,
      checking: false,
      latest: {
        version: '9.9.9',
        tag: 'v9.9.9/../../../evil',
        name: 'Срочное обновление!',
        body: '<img src=x onerror="window.__pwned=1">\n\n[скачать](https://evil.example/setup.exe)',
        publishedAt: '',
        assets: [
          { name: '../../../evil.exe', size: 10 },
          { name: 'ok.exe', size: 10 }
        ],
        sums: {}
      }
    })
  })
  await page.waitForTimeout(400)
  const bad = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.zy-upd-file button')].length,
    files: [...document.querySelectorAll('.zy-upd-file-name')].map((e) => e.textContent),
    releaseBtn: [...document.querySelectorAll('.zy-upd-foot button')].map((b) => b.textContent),
    pwned: !!window.__pwned,
    html: document.querySelector('.zy-upd-notes')?.innerHTML ?? ''
  }))
  ok('кривой тег → кнопки «Скачать» нет ни у одного файла', bad.buttons === 0, bad.files)
  ok('кривой тег → нет кнопки «Открыть страницу релиза»', !bad.releaseBtn.some((t) => t.includes('страницу')), bad.releaseBtn)
  ok('скрипт из тела релиза не выполнился', !bad.pwned)
  ok('onerror вырезан санитайзером', !/onerror/i.test(bad.html), bad.html.slice(0, 120))
  ok('ссылка из заметок обезврежена — кликнуть некуда', !/<a[s>]/i.test(bad.html), bad.html.slice(0, 160))
  ok('но адрес всё равно виден текстом', /evil.example/.test(bad.html), bad.html.slice(0, 160))
  if (shots) await page.screenshot({ path: join(shots, 'upd-2-hostile.png') })

  console.log('\n[5] Установка одним нажатием — только для подписанного релиза')
  // Подпись ставит мейнтейнер ключом, которого нет в CI. Без неё контрольные
  // суммы подтверждает та же машина, что и собирает, — предлагать «Установить»
  // на этом основании значит ручаться за то, чего не проверял.
  const ui = async (signature) => {
    await page.evaluate((s) => window.__zaryaSetUpdate?.(s), {
      ...GOOD,
      canInstall: true,
      downloaded: false,
      ...(signature ? { signature } : {})
    })
    await page.waitForTimeout(300)
    return page.evaluate(() => ({
      text: document.querySelector('.zy-upd')?.textContent ?? '',
      buttons: [...document.querySelectorAll('.zy-upd-foot button')].map((b) => b.textContent),
      accent: [...document.querySelectorAll('.zy-upd-foot button')]
        .filter((b) => b.className.includes('accent'))
        .map((b) => b.textContent),
      warning: document.querySelector('.zy-set-warning')?.textContent ?? ''
    }))
  }

  let v = await ui('ok')
  ok('подписан → кнопка «Установить» есть', v.buttons.some((t) => t.includes('Установить')), v.buttons)
  ok('подписан → предупреждения нет', !v.warning, v.warning)
  ok('подписан → акцент на установке', v.accent.some((t) => t.includes('Установить')), v.accent)

  v = await ui('missing')
  ok('без подписи → кнопки «Установить» нет', !v.buttons.some((t) => t.includes('Установить')), v.buttons)
  ok('без подписи → сказано почему', v.warning.includes('нет подписи'), v.warning)
  ok('без подписи → ручной путь стал главным', v.accent.some((t) => t.includes('страницу релиза')), v.accent)
  ok('без подписи → файл всё равно можно скачать руками', v.text.includes('Zarya-Setup-0.5.2-win-x64.exe'))

  v = await ui('bad')
  ok('подпись не сходится → кнопки «Установить» нет', !v.buttons.some((t) => t.includes('Установить')), v.buttons)
  ok('подпись не сходится → сказано прямо', v.warning.includes('не сходится'), v.warning)
  if (shots) await page.screenshot({ path: join(shots, 'upd-3-unsigned.png') })

  /*
   * Открытое окно не должно показывать вчерашний ответ как сегодняшний.
   *
   * Подпись релиза появляется ПОЗЖЕ сборки — её ставит человек ключом, которого
   * нет в CI. Проверка же шла один раз при запуске, поэтому окно могло
   * честно говорить «у релиза нет подписи автора» ещё долго после того, как
   * подпись легла: так и случилось на 0.7.3.
   *
   * Сеть здесь не нужна: подменяем сам вызов проверки счётчиком.
   */
  /*
   * Ответ получасовой давности не должен выглядеть свежим.
   *
   * Само РЕШЕНИЕ переспросить проверяется юнитами (shouldRecheck в
   * tests/updates.test.ts): подменить `window.zarya` отсюда нельзя — объект
   * из contextBridge защищён от записи, а пускать прогон в настоящую сеть
   * значит получить живой ответ GitHub поверх подставленного состояния. Здесь
   * проверяется то, что видно человеку: время последней проверки на экране.
   */
  console.log('\n[6] Видно, когда спрашивали в последний раз')
  await page.evaluate((s) => window.__zaryaSetUpdate?.(s), {
    ...GOOD,
    signature: 'missing',
    checkedAt: Date.UTC(2026, 7, 3, 9, 7)
  })
  await page.evaluate(() => window.__zaryaSetUi?.({ updateOpen: true }))
  await page.waitForTimeout(500)
  const when = await page.evaluate(
    () => document.querySelector('.zy-upd-foot-when')?.textContent ?? ''
  )
  ok('в подвале названо время проверки', /\d\d:\d\d/.test(when), when)
  ok('и это отдельная оговорка, а не часть обещания', when.trim().startsWith('·'), when)

  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-upd-foot button')].map((b) => b.textContent)
  )
  ok('кнопка спросить руками на месте', btns.some((b) => b?.includes('Проверить')), btns)

  console.log(`\n[update-view] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
