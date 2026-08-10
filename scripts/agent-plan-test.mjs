/**
 * План агента в ленте и подписи карточек инструментов.
 *
 * Повод: агент ведёт себе чек-лист (TaskCreate/TaskUpdate), и в консоли этот
 * список висит на виду — видно, куда он идёт и на каком шаге. В Заре его не было
 * вовсе: карточки подписывались голым именем инструмента, а связь между ними
 * терялась. Здесь проверяется, что план собран, показан и что карточки называют
 * ПРЕДМЕТ вызова, а не инструмент.
 *
 * Тонкость, ради которой прогон и написан: у `TaskCreate` НЕТ идентификатора —
 * движок называет его только в тексте результата («Task #1 created…»), а
 * `TaskUpdate` приходит уже с номером. Фейк повторяет это дословно, поэтому
 * прогон проверяет настоящий путь сборки, а не удобную выдумку.
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-plan-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-planw-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

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
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1100, 700)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.waitForTimeout(600)

  console.log('\n[1] План собирается и виден')
  await page.evaluate(() => window.__zaryaAskAgent?.('построй план работы', 'codex'))
  await page.waitForTimeout(3500)
  const panel = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-plan')
    if (!el) return null
    return {
      title: el.querySelector('.zy-mf-plan-title')?.textContent ?? '',
      count: el.querySelector('.zy-mf-plan-count')?.textContent ?? '',
      rows: [...el.querySelectorAll('.zy-mf-plan-row')].map((r) => ({
        cls: r.className.replace('zy-mf-plan-row', '').trim(),
        mark: r.querySelector('.zy-mf-plan-mark')?.textContent ?? '',
        what: r.querySelector('.zy-mf-plan-what')?.textContent ?? ''
      }))
    }
  })
  ok('панель плана на экране', !!panel, panel)
  ok('все три задачи собраны', panel?.rows.length === 3, panel?.rows.length)
  ok('сказано, сколько сделано', /1 из 3/.test(panel?.count ?? ''), panel?.count)

  console.log('\n[2] Три состояния различимы')
  const byCls = (c) => panel?.rows.filter((r) => r.cls.includes(c)) ?? []
  ok('есть идущая задача', byCls('in_progress').length === 1, panel?.rows)
  ok('есть выполненная', byCls('completed').length === 1, panel?.rows)
  ok('есть ожидающая', byCls('pending').length === 1, panel?.rows)
  // Значки должны РАЗЛИЧАТЬСЯ: одинаковая пометка у трёх состояний — то же
  // самое, что не показывать состояние вовсе.
  const marks = new Set((panel?.rows ?? []).map((r) => r.mark))
  ok('у каждого состояния свой значок', marks.size === 3, [...marks])

  console.log('\n[3] Идущая задача — первой и своей формой')
  ok(
    'идущая стоит первой строкой',
    (panel?.rows[0]?.cls ?? '').includes('in_progress'),
    panel?.rows[0]
  )
  // Движок даёт для идущей задачи отдельную форму («Переписываю разбор» вместо
  // «Переписать разбор») — именно она отвечает на вопрос «чем занят сейчас».
  ok(
    'показана форма движка, а не название задачи',
    panel?.rows[0]?.what === 'Переписываю разбор',
    panel?.rows[0]?.what
  )

  console.log('\n[4] Карточки Task* не дублируют панель')
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-cmd')].map((e) => e.textContent ?? '')
  )
  ok('карточек TaskCreate/TaskUpdate в ленте нет', cards.length === 0, cards)

  console.log('\n[5] Карточка называет предмет вызова, а не инструмент')
  // Инструменты, которые раньше выпадали в голое имя: 6 254 вызова поиска в
  // вебе и 6 018 поисков по файлам на машине владельца — каждый второй ход.
  await page.evaluate(() => window.__zaryaAskAgent?.('покажи подписи', 'codex'))
  await page.waitForTimeout(2200)
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-tool-cmd')].map((e) => e.textContent ?? '')
  )
  ok('поиск подписан запросом, а не словом WebSearch', labels.some((l) => /kimi cli acp/.test(l)), labels)
  ok('поиск по файлам — ШАБЛОНОМ, а не папкой', labels.some((l) => /launchPadOpen/.test(l)), labels)
  ok('файл — своим именем', labels.some((l) => /hero[.]png/.test(l)), labels)
  ok(
    'ни одна карточка не подписана голым именем инструмента',
    !labels.some((l) => ['WebSearch', 'Grep', 'SendUserFile'].includes(l.trim())),
    labels
  )

  if (shots) await page.screenshot({ path: join(shots, 'agent-plan.png') })
  console.log(`\n[agent-plan] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
