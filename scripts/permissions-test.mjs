/**
 * Панель разрешений (inc-28) — на живом окне.
 *
 * Выдать правило можно было только на гейте, в тот единственный миг, когда
 * карточка ждёт ответа. Посмотреть, что уже роздано, и забрать обратно — негде:
 * согласие давалось навсегда и в спешке. Здесь проверяется, что оно ВИДНО и
 * ОТЗЫВАЕТСЯ, и что отзыв правда возвращает вопрос.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-perm-'))
const extra = mkdtempSync(join(tmpdir(), 'zarya-perm-extra-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extraInfo) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extraInfo !== undefined ? '→ ' + JSON.stringify(extraInfo) : '')
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
    // Системный диалог выбора папки из Playwright не нажать; проверяем всё,
    // что после него.
    ZARYA_PICK_DIR: extra,
    NODE_ENV: 'production'
  }
})

const panel = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.zy-perm-panel')
    if (!el) return null
    return {
      stage: el.querySelector('.zy-perm-sub')?.textContent ?? '',
      note: el.querySelector('.zy-perm-note')?.textContent ?? '',
      empty: el.querySelector('.zy-perm-empty')?.textContent ?? null,
      rules: Array.from(el.querySelectorAll('.zy-perm-item')).map((r) => ({
        tool: r.querySelector('.zy-perm-tool')?.textContent ?? '',
        cmd: r.querySelector('.zy-perm-cmd')?.textContent ?? '',
        dir: r.querySelector('.zy-perm-dir')?.textContent ?? '',
        revoke: !!r.querySelector('.zy-perm-revoke')
      })),
      said: el.querySelector('.zy-perm-note--said')?.textContent ?? null
    }
  })

const openPanel = async (page) => {
  await page.click('.zy-agentbar-gate', { button: 'right' })
  await page.waitForTimeout(400)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  console.log('\n[1] Пустая панель говорит, что ничего не выдано')
  const convId = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'tool please'))
  await page.waitForTimeout(1400)
  await openPanel(page)
  let p = await panel(page)
  ok('панель открылась правым щелчком по замку', !!p, p)
  ok('ступень названа', /спрашивать/i.test(p?.stage ?? ''), p?.stage)
  ok(
    'сказано, что часть команд движок разрешает сам',
    /echo/i.test(p?.note ?? ''),
    p?.note
  )
  ok('пустой список объяснён словами', /ничего не выдано/i.test(p?.empty ?? ''), p?.empty)
  if (shots) await page.screenshot({ path: join(shots, 'permissions-empty.png') })

  console.log('\n[2] Выданное правило видно дословно и отзывается')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Выдаём правило тем же путём, что и человек кнопкой на гейте.
  const toolId = await page.evaluate((cid) => {
    const c = window.__zaryaConvById?.(cid)
    return c?.pendingTools?.[0]?.id ?? null
  }, convId)
  ok('гейт на месте — есть что разрешать', !!toolId, toolId)
  await page.evaluate(
    ([cid, tid]) => window.__zaryaAllowForSession?.(cid, tid),
    [convId, toolId]
  )
  await page.waitForTimeout(700)
  await openPanel(page)
  p = await panel(page)
  const rule = (p?.rules ?? []).find((r) => r.tool === 'Bash')
  ok('правило в списке', !!rule, p?.rules)
  ok('команда показана целиком, а не многоточием', rule?.cmd === 'echo fake', rule)
  ok('у правила есть кнопка отзыва', rule?.revoke === true, rule)
  if (shots) await page.screenshot({ path: join(shots, 'permissions-rule.png') })

  console.log('\n[3] Отзыв правда возвращает вопрос')
  await page.click('.zy-perm-item .zy-perm-revoke')
  await page.waitForTimeout(400)
  p = await panel(page)
  ok('правила в списке больше нет', !(p?.rules ?? []).some((r) => r.tool === 'Bash'), p?.rules)
  const allows = await page.evaluate(
    (cid) => window.__zaryaConvById?.(cid)?.sessionAllows ?? [],
    convId
  )
  ok('и в состоянии беседы тоже', allows.length === 0, allows)
  // Второй такой же вызов должен снова спросить.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.evaluate((cid) => window.__zaryaSendIn?.(cid, 'tool again'), convId)
  await page.waitForTimeout(1600)
  const gates = await page.evaluate(
    (cid) => (window.__zaryaConvById?.(cid)?.pendingTools ?? []).filter((t) => !t.settled).length,
    convId
  )
  ok('следующий такой вызов снова спрашивают', gates >= 1, gates)

  console.log('\n[4] Рабочие папки: своя видна, чужая добавляется и отзывается')
  await page.evaluate((cid) => window.__zaryaDenyFirst?.(cid), convId)
  await page.waitForTimeout(1200)
  await openPanel(page)
  p = await panel(page)
  const base = (p?.rules ?? []).find((r) => r.dir && !r.revoke)
  ok('папка беседы показана и не отзывается', !!base, p?.rules)

  await page.click('.zy-perm-add')
  await page.waitForTimeout(900)
  p = await panel(page)
  /*
   * Сказано именно ТО, ЧТО ПРОИСХОДИТ. Проверено зондами к SDK: работать за
   * пределами рабочей папки агент может и без списка — каждый раз через
   * вопрос; папка из списка снимает вопрос про чтение внутри неё. Слово
   * «доступ» здесь было бы неправдой в пользу интерфейса.
   */
  ok('сказано, что папка стала своей', /не спросят/i.test(p?.said ?? ''), p?.said)
  ok('и НЕ обещано, что доступ появился', !/доступ/i.test(p?.said ?? ''), p?.said)
  const added = (p?.rules ?? []).find((r) => r.dir && r.revoke)
  ok('новая папка в списке', !!added, p?.rules)
  const dirs = await page.evaluate(
    (cid) => window.__zaryaConvById?.(cid)?.extraDirs ?? [],
    convId
  )
  ok('и в состоянии беседы', dirs.length === 1, dirs)
  if (shots) await page.screenshot({ path: join(shots, 'permissions-dirs.png') })

  /*
   * Отзываем именно ПАПКУ: у правил кнопка та же, и «последняя на странице»
   * проверяла бы что попало.
   *
   * Щелчок НАСТОЯЩИЙ, через локатор. Событие, разосланное из `evaluate`, минует
   * хит-тест — именно так однажды был подписан drop-обработчик, который на
   * самом деле не работал, потому что его накрывал другой слой.
   */
  await page.locator('.zy-perm-item:has(.zy-perm-dir) .zy-perm-revoke').last().click()
  await page.waitForTimeout(500)
  const after = await page.evaluate(
    (cid) => window.__zaryaConvById?.(cid)?.extraDirs ?? [],
    convId
  )
  ok('доступ к папке забирается обратно', after.length === 0, after)

  console.log(`\n[permissions] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
