/**
 * Раздел «Скиллы» во вкладке «Инструменты».
 *
 * Скилл платный всегда: имя и описание лежат в контексте КАЖДОГО запроса, даже
 * если скилл ни разу не сработал. Раздел существует ради этой цены — и ради
 * четырёх состояний, из которых средние два («только имя», «только по /»)
 * дешевле выключения и ничего не ломают.
 *
 * Проверяется то, чего юнит не увидит, — обещания интерфейса:
 *   1. цена названа поимённо, дорогие сверху;
 *   2. у плагинного скилла НЕТ переключателя (движок его `skillOverrides` не
 *      берёт) — вместо кнопки, которая сделала бы вид, стоит рабочая команда;
 *   3. перекрытый настройкой проекта не даёт переключателя и называет виновника:
 *      запись в личные настройки прошла бы «успешно» и не изменила ничего;
 *   4. выключенный скилл ОСТАЁТСЯ в списке — иначе дверь открывалась бы в одну
 *      сторону и вернуть его было бы нечем;
 *   5. на экране сказано, чей файл правится, ДО нажатия.
 *
 * Агенты фейковые (ZARYA_FAKE_AGENT): ни сети, ни живого Claude, и — главное —
 * ни одной записи в настоящие `~/.claude/settings.json`.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-skills-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
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
  await page.waitForTimeout(2500)

  // Просим агента взять скилл: раздел обязан отличать «сработал» от «просто
  // лежит в контексте» — платится за оба одинаково, а решение это меняет.
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'возьми skill'))
  await page.waitForTimeout(2400)
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.zy-settings-nav-item')]
    items
      .find((el) => el.textContent?.includes('Инструменты'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(700)

  /** Строки скиллов так, как их видит человек. */
  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.zy-skills-row')].map((el) => ({
        name: el.querySelector('.zy-skills-name')?.textContent ?? '',
        src: el.querySelector('.zy-skills-src')?.textContent ?? '',
        price: el.querySelector('.zy-skills-price')?.textContent ?? '',
        why: el.querySelector('.zy-skills-why')?.textContent ?? '',
        // Переключатель ИЛИ статичное слово — ровно то, что решает, врёт ли строка.
        select: el.querySelector('.zy-skills-select')
          ? [...el.querySelectorAll('.zy-skills-select option')].map((o) => o.textContent)
          : null,
        value: el.querySelector('.zy-skills-select')?.value ?? '',
        tip: el.querySelector('.zy-skills-select')?.getAttribute('title') ?? '',
        state: el.querySelector('.zy-skills-state')?.textContent ?? '',
        cmd: el.querySelector('.zy-tools-cmd')?.textContent ?? ''
      }))
    )

  console.log('\n[1] Скиллы показаны с ценой, дорогие сверху')
  const r1 = await rows()
  ok('строки скиллов есть', r1.length === 5, r1.length)
  ok(
    'порядок: дорогие сверху, выключенный внизу',
    r1.map((r) => r.name).join(',') ===
      'code-review,dataviz,cloudflare:email-service,team-deploy,legacy-context',
    r1.map((r) => r.name)
  )
  ok('у дорогого названа цена в токенах', /620/.test(r1[0].price), r1[0].price)
  ok('источник назван словом, а не кодом', r1[0].src === 'личный', r1[0].src)
  ok('встроенный подписан «встроенный»', r1[1].src === 'встроенный', r1[1].src)
  const total = await page.evaluate(
    () => document.querySelector('.zy-skills-total')?.textContent ?? ''
  )
  ok('итог по скиллам на экране', /1\s190/.test(total), total)
  ok('и он про КАЖДЫЙ запрос, а не про разовую трату', /запрос/.test(total), total)
  const sub = await page.evaluate(() => document.querySelector('.zy-skills-sub')?.textContent ?? '')
  ok('сказано, что в контекст вошли не все', /4 из 5/.test(sub), sub)

  console.log('\n[2] Четыре состояния — а не галочка')
  ok('у обычного скилла переключатель', !!r1[0].select, r1[0].select)
  ok(
    'в нём ровно четыре состояния движка',
    r1[0].select?.length === 4 &&
      r1[0].select.join(',') === 'в работе,только имя,только по «/»,выключен',
    r1[0].select
  )
  // Объяснение — по наведению, а не строкой под каждым скиллом: восемьдесят
  // раз подряд одна и та же фраза «берёт сам» скрывает сами скиллы.
  ok('что состояние значит — сказано по наведению', /видит имя и описание/.test(r1[0].tip), r1[0].tip)
  ok(
    'и не печатается строкой у обычного скилла',
    r1[0].why === '',
    r1[0].why
  )

  console.log('\n[3] Плагинный скилл не притворяется управляемым')
  const plug = r1[2]
  ok('переключателя у него НЕТ', plug.select === null, plug.select)
  ok('сказано почему', /плагин/.test(plug.why), plug.why)
  // Команда — одной строкой на весь список, а не под каждым скиллом: у человека
  // на один плагин приходится десяток скиллов, и повтор превращается в стену.
  const plugRow = await page.evaluate(() => {
    const box = document.querySelector('.zy-skills-plugins')
    return box
      ? {
          text: box.querySelector('.zy-skills-plugins-text')?.textContent ?? '',
          btns: [...box.querySelectorAll('.zy-skills-plugin-btn')].map((b) => ({
            name: b.textContent ?? '',
            cmd: b.getAttribute('title') ?? ''
          }))
        }
      : null
  })
  ok('под списком названы плагины, а не повтор под каждой строкой', !!plugRow, plugRow)
  ok('плагин назван один раз', plugRow?.btns.length === 1, plugRow?.btns)
  ok(
    'и за ним стоит команда, которая правда выключает',
    plugRow?.btns[0]?.cmd === 'claude plugin disable cloudflare',
    plugRow?.btns
  )
  ok('в строке самого скилла команды больше нет', plug.cmd === '', plug.cmd)

  console.log('\n[4] Перекрытый настройкой проекта — без кнопки, которая соврёт')
  const locked = r1[3]
  ok('переключателя нет', locked.select === null, locked.select)
  ok('состояние показано словом', locked.state.includes('только имя'), locked.state)
  ok('назван виновник — настройки проекта', /настройках проекта/.test(locked.why), locked.why)

  console.log('\n[5] Выключенный виден — дверь открывается в обе стороны')
  const off = r1[4]
  ok('выключенный скилл в списке есть', off.name === 'legacy-context', off.name)
  ok('у него есть переключатель, чтобы вернуть', !!off.select, off.select)
  ok('цена честно не выдумана', /вне контекста/.test(off.price), off.price)

  console.log('\n[6] Переключение доходит до движка')
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.zy-skills-row')].find(
      (el) => el.querySelector('.zy-skills-name')?.textContent === 'code-review'
    )
    const sel = row?.querySelector('.zy-skills-select')
    if (sel) {
      sel.value = 'user-invocable-only'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await page.waitForTimeout(900)
  const r2 = await rows()
  const moved = r2.find((r) => r.name === 'code-review')
  // Читаем ЗНАЧЕНИЕ переключателя, а не подсказку под ним: подсказка меняется
  // вместе с состоянием и потому легко выдаёт «прошло» там, где не прошло.
  ok('переключатель встал в новое состояние', moved?.value === 'user-invocable-only', moved)
  ok('и подсказка под ним объясняет именно его', /вызовешь через/.test(moved?.why ?? ''), moved?.why)
  const note = await page.evaluate(() => {
    const el = document.querySelector('.zy-tools-note')
    return el ? { text: el.textContent ?? '', bad: el.className.includes('--bad') } : null
  })
  ok('сказано, когда изменение подействует', /следующая беседа/.test(note?.text ?? ''), note)
  // Удача не красится в цвет отказа: красный в Заре значит «сломано».
  ok('и это не выглядит ошибкой', note?.bad === false, note)

  console.log('\n[7] Сработавший скилл отличается от просто оплаченного')
  const subs = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-sub')].map((el) => el.textContent ?? '')
  )
  ok(
    'сказано, сколько скиллов реально сработало',
    subs.some((x) => /сработали: 1 из 5/.test(x)),
    subs
  )
  const marked = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-row')]
      .filter((el) => el.querySelector('.zy-skills-used'))
      .map((el) => el.querySelector('.zy-skills-name')?.textContent ?? '')
  )
  ok('помечен именно тот, который агент взял', marked.join(',') === 'code-review', marked)
  const firstName = await page.evaluate(
    () => document.querySelector('.zy-skills-row .zy-skills-name')?.textContent ?? ''
  )
  ok('и он поднят наверх — его как раз трогать нельзя', firstName === 'code-review', firstName)

  console.log('\n[8] Карточка в ленте называет скилл, а не пишет голое «Skill»')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false }))
  await page.waitForTimeout(600)
  const card = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-cmd')].map((el) => el.textContent ?? '')
  )
  ok('в ленте названо имя скилла', card.some((c) => /скилл code-review/.test(c)), card)
  ok('и его задание рядом', card.some((c) => /дифф ветки/.test(c)), card)
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(600)

  console.log('\n[9] История наблюдения честно называет период')
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-sub')].map((el) => el.textContent ?? '')
  )
  ok(
    'период назван честно — один день наблюдения, а не «за 30 дней»',
    seen.some((x) => /1 день наблюдения/.test(x)),
    seen
  )
  ok('и сказано, что счёт локальный', seen.some((x) => /на этой машине/.test(x)), seen)
  const freq = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-row')].map((el) => ({
      name: el.querySelector('.zy-skills-name')?.textContent ?? '',
      freq: el.querySelector('.zy-skills-freq')?.textContent ?? ''
    }))
  )
  ok(
    'у сработавшего показана частота',
    /1×/.test(freq.find((r) => r.name === 'code-review')?.freq ?? ''),
    freq
  )
  ok(
    'у остальных — честное «ни разу»',
    freq.filter((r) => r.name !== 'code-review').every((r) => r.freq === 'ни разу'),
    freq
  )

  console.log('\n[10] Прямой ответ на «что выключить»')
  const idle = await page.evaluate(() => {
    const box = document.querySelector('.zy-skills-idle')
    return box ? { text: box.textContent ?? '' } : null
  })
  ok('названы те, что не сработали ни разу', !!idle, idle)
  ok('и их цена в токенах, а не только число', /токенов/.test(idle?.text ?? ''), idle)
  // Кандидаты — не приговор: скилл может быть нужен раз в квартал.
  ok('сказано, что это кандидаты, а не приговор', /кандидаты/.test(idle?.text ?? ''), idle)
  await page.evaluate(() => {
    const b = document.querySelector('.zy-skills-idle button')
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(500)
  const shownIdle = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-skills-row .zy-skills-name')].map((el) => el.textContent)
  )
  ok('нажатие показывает именно их', !shownIdle.includes('code-review'), shownIdle)
  await page.evaluate(() => {
    const b = document.querySelector('.zy-skills-idle button')
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(400)

  console.log('\n[11] Нечитаемый файл настроек — отказ, а не затирание')
  // Самая дорогая ошибка этого инкремента: раньше «не смог прочитать» было
  // неотличимо от «файла нет», и переключение скилла клало поверх чужого
  // конфига объект из одного ключа — модель, хуки и плагины исчезали молча.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.zy-skills-row')].find(
      (el) => el.querySelector('.zy-skills-name')?.textContent === 'dataviz'
    )
    const sel = row?.querySelector('.zy-skills-select')
    if (sel) {
      sel.value = 'off'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await page.waitForTimeout(800)
  const badNote = await page.evaluate(() => {
    const el = document.querySelector('.zy-tools-note')
    return el ? { text: el.textContent ?? '', bad: el.className.includes('--bad') } : null
  })
  ok('сказано, что файл прочитать не удалось', /не удалось прочитать/i.test(badNote?.text ?? ''), badNote)
  ok('назван сам файл', /settings\.json/.test(badNote?.text ?? ''), badNote)
  ok('и дан ручной путь — что чинить', /запятая|BOM/i.test(badNote?.text ?? ''), badNote)
  ok('это показано как отказ, а не как удача', badNote?.bad === true, badNote)

  console.log('\n[12] Отказ на перекрытом ключе — не молчаливая «удача»')
  const denied = await page.evaluate(
    (cid) => window.zarya.agent.skillOverride('codex', cid, 'team-deploy', 'off'),
    id
  )
  ok('движок отказал', denied?.ok === false, denied)
  ok('и назвал слой, который перебил', denied?.reason === 'overridden' && denied?.by === 'project', denied)

  console.log('\n[13] Чей файл правится — сказано ДО нажатия')
  const foots = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-tools-foot')].map((el) => el.textContent ?? '')
  )
  ok(
    'подпись про личные настройки Claude Code на экране',
    foots.some((f) => f.includes('~/.claude/settings.json')),
    foots
  )
  ok(
    'и сказано, что это НЕ настройки Зари',
    foots.some((f) => /не в настройки Зари/.test(f)),
    foots
  )

  if (shots) await page.screenshot({ path: join(shots, 'skills-panel.png') })
  console.log(`\n[skills-panel] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
