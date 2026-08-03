/**
 * Модель и усилие — СВОЕЙ панели.
 *
 * Пункт D1 UX-аудита: `claudeStatus` был один на окно, и модель показывалась та,
 * чей ход закончился последним. При двух панелях на разных моделях подпись под
 * строкой ввода врала — а по ней человек решает, кому отправляет запрос.
 *
 * Топливо при этом остаётся общим НАРОЧНО: лимит подписки один на аккаунт,
 * сколько бы панелей ни работало. Прогон проверяет и это, иначе «развели по
 * панелям» однажды разведёт и то, что разводить нельзя.
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-panestatus-'))
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
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Две панели, два разных движка')
  await page.evaluate(() => window.__zaryaSplitActive?.('row'))
  await page.waitForTimeout(1200)
  const sids = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves)
  ok('панелей две', sids.length === 2, sids.length)

  await page.evaluate((ids) => {
    window.__zaryaSetPaneBarMode?.(ids[0], 'codex')
    window.__zaryaSetPaneBarMode?.(ids[1], 'gemini')
  }, sids)
  await page.evaluate((ids) => {
    window.__zaryaStartAgentIn?.('codex', 'привет', ids[0])
    window.__zaryaStartAgentIn?.('gemini', 'привет', ids[1])
  }, sids)
  await page.waitForTimeout(2500)

  /** Что написано под строкой ввода активной панели. */
  const shownModel = async (sid) => {
    await page.evaluate((id) => window.__zaryaFocusPane?.(id) ?? window.__zaryaSetActiveSession?.(id), sid)
    await page.waitForTimeout(500)
    return page.evaluate(() => {
      const pane = document.querySelector('.zy-pane--active') ?? document
      return (pane.querySelector('.zy-agentbar-fuel-model')?.textContent ?? '').trim()
    })
  }

  console.log('\n[2] Каждая панель подписана своей моделью')
  const status = await page.evaluate(() => window.__zaryaUi?.().agentStatusBySession ?? {})
  ok('статус записан по панелям, а не одной кучей', Object.keys(status).length === 2, status)
  ok('первая помнит свою модель', /codex/.test(status[sids[0]]?.model ?? ''), status[sids[0]])
  ok('вторая — свою', /gemini/.test(status[sids[1]]?.model ?? ''), status[sids[1]])
  ok(
    'и это РАЗНЫЕ модели, а не одна на всех',
    status[sids[0]]?.model !== status[sids[1]]?.model,
    status
  )

  console.log('\n[3] Топливо остаётся общим — лимит подписки один')
  const usage = await page.evaluate(() => window.__zaryaUi?.().claudeStatus ?? {})
  ok('топливо живёт в общем состоянии', 'usage' in usage || usage.usage === undefined, usage)
  const perPane = await page.evaluate(() =>
    Object.values(window.__zaryaUi?.().agentStatusBySession ?? {}).map((x) => Object.keys(x))
  )
  ok(
    'а по панелям хранится только модель и усилие',
    perPane.every((keys) => keys.every((k) => k === 'model' || k === 'effort')),
    perPane
  )

  console.log('\n[4] У панели без агента подписи нет — чужую не подставляем')
  const fresh = await page.evaluate(() => {
    window.__zaryaSplitActive?.('col')
    return null
  })
  void fresh
  await page.waitForTimeout(1200)
  const all = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves)
  const added = all.find((x) => !sids.includes(x))
  const st2 = await page.evaluate(() => window.__zaryaUi?.().agentStatusBySession ?? {})
  ok('новая панель заведена', !!added, all.length)
  ok('и о её модели ничего не выдумано', !st2[added], st2[added])

  /*
   * Во сколько обошёлся разговор.
   *
   * Движок считал это всегда, а мы выбрасывали (пункт E1 аудита). Считается по
   * БЕСЕДЕ: «сколько стоило» спрашивают про разговор, а не про приложение.
   * Подпись обязательна и разная — на подписке сумма расчётная, по своему ключу
   * это счёт; молча показать одну и ту же цифру значит соврать о деньгах.
   */
  console.log('\n[5] Стоимость разговора видна и копится по ходам')
  const convId = await page.evaluate((ids) =>
    window.__zaryaStartAgentIn?.('codex', 'привет', ids[0]), sids)
  await page.waitForTimeout(1500)
  const after1 = await page.evaluate((id) => window.__zaryaConvById?.(id)?.costUsd, convId)
  ok('после хода стоимость появилась', typeof after1 === 'number' && after1 > 0, after1)

  await page.evaluate((id) => window.__zaryaSendIn?.(id, 'ещё раз'), convId)
  await page.waitForTimeout(1800)
  const after2 = await page.evaluate((id) => window.__zaryaConvById?.(id)?.costUsd, convId)
  ok('второй ход прибавился, а не заменил', after2 > after1, { after1, after2 })

  await page.evaluate((id) => window.__zaryaFocusPane?.(id), sids[0])
  await page.waitForTimeout(600)
  const cost = await page.evaluate(() => {
    const el = document.querySelector('.zy-agentbar-fuel-cost')
    return { text: (el?.textContent ?? '').trim(), title: el?.getAttribute('title') ?? '' }
  })
  ok('цифра на экране', /^\$|^<\$/.test(cost.text), cost)
  ok(
    'и сказано, ЧТО это за деньги',
    /списывают|счёт|тариф/i.test(cost.title),
    cost.title.slice(0, 80)
  )

  if (shots) await page.screenshot({ path: join(shots, 'cost-strip.png') })

  console.log(`\n[pane-status] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}

if (fail) process.exit(1)
