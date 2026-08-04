/**
 * Пол под автопилотом и «разрешить до конца сессии».
 *
 * Раньше выбор был из двух положений: подтверждать `git status` по сто раз за
 * день — или снять гейт целиком и получить `rm -rf` без вопроса. Люди выбирают
 * второе, потому что первое невыносимо, и это худший исход.
 *
 * Прогон проверяет, что появилась середина и что у неё есть дно:
 * — «до конца сессии» больше не спрашивает про ТУ ЖЕ команду;
 * — но про другую спрашивает, даже если начало совпадает;
 * — необратимое показывается всегда, даже при включённом автопилоте, и
 *   разрешить его «до конца сессии» нельзя вообще.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-floor-'))
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
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

/** Ждём, пока в беседе появится нерешённый гейт (или не появится). */
const waitGate = async (page, convId, ms = 3000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const t = await page.evaluate(
      (id) => window.__zaryaConvById?.(id)?.pendingTools?.find((x) => !x.settled) ?? null,
      convId
    )
    if (t) return t
    await page.waitForTimeout(200)
  }
  return null
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(300)

  console.log('\n[1] У карточки три решения, а не два')
  const id1 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  ok('гейт встал', !!(await waitGate(page, id1)))
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-actions button')].map((b) => b.textContent.trim())
  )
  ok('есть «до конца сессии»', buttons.includes('ДО КОНЦА СЕССИИ'), buttons)
  ok('и обычные «выполнить»/«отклонить»', buttons.includes('ВЫПОЛНИТЬ') && buttons.includes('ОТКЛОНИТЬ'), buttons)

  console.log('\n[2] Разрешённое больше не спрашивают — но только его')
  const tool1 = await waitGate(page, id1)
  await page.evaluate(([c, t]) => window.__zaryaAllowForSession?.(c, t), [id1, tool1.id])
  await page.waitForTimeout(700)
  const rules = await page.evaluate((id) => window.__zaryaConvById?.(id)?.sessionAllows ?? [], id1)
  ok('правило записано дословно', rules.includes('Bash: echo fake'), rules)

  // Второй ход в ТОЙ ЖЕ беседе: правило — её свойство, и у новой беседы своих
  // правил нет, как и должно быть.
  await page.evaluate((id) => window.__zaryaSendIn?.(id, 'run a tool please'), id1)
  await page.waitForTimeout(2000)
  const still = await page.evaluate(
    (id) => window.__zaryaConvById?.(id)?.pendingTools?.filter((x) => !x.settled).length ?? 0,
    id1
  )
  ok('та же команда прошла без вопроса', still === 0, still)

  // А новая беседа спрашивает заново — «до конца сессии» не значит «навсегда».
  const idFresh = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  ok('в новой беседе спрашивают снова', !!(await waitGate(page, idFresh)))

  console.log('\n[3] Необратимое спрашивают всегда')
  // Автопилот включаем на самой беседе — он свойство беседы, а не панели.
  const convId = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(800)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), convId)
  await page.waitForTimeout(300)

  const id3 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  await page.waitForTimeout(1800)
  const quiet = await page.evaluate(
    (id) => window.__zaryaConvById?.(id)?.pendingTools?.filter((x) => !x.settled).length ?? 0,
    id3
  )
  ok('при автопилоте обычное не спрашивают', quiet === 0, quiet)

  const id4 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a danger tool'))
  const danger = await waitGate(page, id4)
  ok('а «rm -rf» — спрашивают', !!danger, danger)
  ok('и сказано, почему', !!danger?.irreversible, danger?.irreversible)
  ok('в подписи видна сама команда', (danger?.irreversible?.hit ?? '').includes('rm -rf'), danger?.irreversible)

  const dangerButtons = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-actions button')].map((b) => b.textContent.trim())
  )
  ok(
    'разрешить его «до конца сессии» нельзя',
    !dangerButtons.includes('ДО КОНЦА СЕССИИ'),
    dangerButtons
  )
  const warn = await page.evaluate(() => document.querySelector('.zy-mf-tool-stop')?.textContent ?? '')
  ok('предупреждение на экране', warn.includes('не отменить'), warn.slice(0, 60))

  /*
   * Пометка сервера — не то же, что наш пол.
   *
   * MCP разрешает серверу объявить свой инструмент разрушающим. Мы такую
   * пометку показываем, но ручаться за неё не можем: сервер вправе её не
   * заполнить или ошибиться. Поэтому она обязана быть ОТДЕЛЬНОЙ строкой и
   * называть источник — иначе чужое заявление читается как наше обещание.
   */
  console.log('\n[4] Пометку сервера показываем, но не выдаём за свою')
  const id5 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run an mcp tool'))
  const mcpGate = await waitGate(page, id5)
  ok('гейт поднялся на инструменте сервера', mcpGate?.name?.startsWith('mcp__'), mcpGate?.name)
  ok('пометка приехала с гейтом', mcpGate?.mcpMark?.destructive === true, mcpGate?.mcpMark)

  const mark = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-mark')?.textContent ?? ''
  )
  ok('на экране сказано, что помечает СЕРВЕР', /[Сс]ервер помечает/.test(mark), mark)
  const floorLine = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-stop')?.textContent ?? ''
  )
  ok(
    'и это не наша строка про необратимое',
    !floorLine || !floorLine.includes('Сервер помечает'),
    floorLine.slice(0, 60)
  )
  if (shots) await page.screenshot({ path: join(shots, 'gate-mcp-mark.png') })
  ok(
    'обычный инструмент такой пометки не получает',
    (danger?.mcpMark ?? null) === null,
    danger?.mcpMark
  )

  /*
   * Правку, которую просят одобрить, обязано быть видно.
   *
   * Для команды это правило соблюдалось давно — текст разворачивается и не
   * сворачивается, пока ждут решения. А `Edit` показывал только путь: человек
   * одобрял изменение вслепую. Здесь проверяется, что дифф на экране, что под
   * ожидающим гейтом он не сворачивается и что номеров строк в нём НЕТ — их
   * неоткуда взять, вызов приносит фрагмент файла, а не файл целиком.
   */
  console.log('\n[5] Правку видно, а не только путь к файлу')
  // Автопилот с раздела [3] обычную правку проглотит — и правильно сделает.
  // Здесь нас интересует случай СО СПРОСОМ, поэтому беседу заводим без него.
  const id6 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(900)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, false), id6)
  await page.waitForTimeout(200)
  await page.evaluate((c) => window.__zaryaSendIn?.(c, 'run an edit tool'), id6)
  const editGate = await waitGate(page, id6)
  ok('гейт на правку поднялся', editGate?.name === 'Edit', editGate?.name)

  const diff = await page.evaluate(() => {
    const box = document.querySelector('.zy-mf-diff')
    if (!box) return null
    return {
      head: (box.querySelector('.zy-mf-diff-head')?.textContent ?? '').trim(),
      added: [...box.querySelectorAll('.zy-mf-diff-row--add .zy-mf-diff-text')].map(
        (e) => e.textContent
      ),
      removed: [...box.querySelectorAll('.zy-mf-diff-row--del .zy-mf-diff-text')].map(
        (e) => e.textContent
      ),
      caret: !!box.querySelector('.zy-mf-diff-caret'),
      body: !!box.querySelector('.zy-mf-diff-body')
    }
  })
  ok('блок правки на экране', !!diff, diff)
  ok('видно, что убрано', (diff?.removed ?? []).includes('const a = 1'), diff?.removed)
  ok('и что добавлено', (diff?.added ?? []).includes('const a = 42'), diff?.added)
  ok(
    'в заголовке счёт изменений',
    /−\d/.test(diff?.head ?? '') && /\+\d/.test(diff?.head ?? ''),
    diff?.head
  )
  ok('пока ждут решения — свернуть нельзя', diff?.caret === false && diff?.body === true, diff)
  if (shots) await page.screenshot({ path: join(shots, 'gate-edit-diff.png') })

  /*
   * И при автопилоте — тоже видно, только постфактум.
   *
   * Вопроса в этом режиме нет вовсе, но человек всё равно должен узнать, ЧТО
   * агент изменил. Заголовок с «−2 +3» остаётся на экране, сам дифф свёрнут:
   * иначе длинный ход превратил бы ленту в простыню.
   */
  console.log('\n[6] При автопилоте правка видна постфактум, но не разворачивается силой')
  const id7 = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(900)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), id7)
  await page.waitForTimeout(200)
  await page.evaluate((c) => window.__zaryaSendIn?.(c, 'run an edit tool'), id7)
  await page.waitForTimeout(2200)
  const silent = await page.evaluate((id) => {
    const conv = window.__zaryaConvById?.(id)
    const boxes = [...document.querySelectorAll('.zy-mf-diff')]
    const box = boxes[boxes.length - 1]
    return {
      gates: conv?.pendingTools?.filter((t) => !t.settled).length ?? 0,
      head: (box?.querySelector('.zy-mf-diff-head')?.textContent ?? '').trim(),
      body: !!box?.querySelector('.zy-mf-diff-body'),
      caret: !!box?.querySelector('.zy-mf-diff-caret')
    }
  }, id7)
  ok('вопроса не было — автопилот', silent.gates === 0, silent.gates)
  ok('но масштаб правки на экране', /−\d/.test(silent.head) && /\+\d/.test(silent.head), silent.head)
  ok('сам дифф свёрнут и открывается по нажатию', silent.body === false && silent.caret === true, silent)
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* временный профиль */
  }
}

console.log(`\n[gate-floor] ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
