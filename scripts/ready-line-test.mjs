/**
 * Строка приглашения «готов · введите запрос в строку ниже ↓» означает «твой
 * ход». Она рендерилась безусловно и висела прямо под «агент отвечает…» — один
 * экран одновременно утверждал, что агент работает и что он свободен.
 *
 * Проверяем на живом окне, а не на предикате: строки НЕТ пока движок стримит,
 * НЕТ пока гейт ждёт решения, и она ВОЗВРАЩАЕТСЯ когда ход снова за человеком.
 * Каждый «нет» подкреплён проверкой, что фид вообще в непустой ветке — иначе
 * отсутствие строки означало бы просто пустой экран, а не рабочий гейт.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-ready-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
})

/** Что реально отрисовано внизу фида. */
const feedState = (page) =>
  page.evaluate(() => ({
    ready: !!document.querySelector('.zy-mf-ready'),
    // Непустая лента = в ней есть НАСТОЯЩЕЕ содержимое. Раньше признаком
    // служил разделитель «ОТВЕТ АГЕНТА», но он рисуется только там, где выше
    // есть команды терминала: в чистой беседе его нет, а лента непуста.
    populated: !!document.querySelector('.zy-mf-user, .zy-mf-answer, .zy-mf-block')
  }))
const convById = (page, id) => page.evaluate((i) => window.__zaryaConvById?.(i), id)
async function waitIdle(page, id, ms = 15000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    await page.waitForTimeout(200)
    const c = await convById(page, id)
    if (c && !c.streaming && (c.pendingTools || []).length === 0) return c
  }
  return convById(page, id)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'codex' }))
  await page.waitForTimeout(400)

  console.log('\n[1] Простой: ход за человеком — строка на месте')
  const idWarm = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'разогрев'))
  await waitIdle(page, idWarm)
  await page.waitForTimeout(400)
  const s1 = await feedState(page)
  ok('фид непустой (не EmptyHero)', s1.populated, s1)
  ok('«готов» видна на отработавшем фиде', s1.ready, s1)
  if (shots) await page.screenshot({ path: join(shots, 'ready-1-idle.png') })

  console.log('\n[2] Агент отвечает — строка молчит')
  const id = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет кодекс'))
  await page.waitForTimeout(250)
  const streaming = await convById(page, id)
  const s2 = await feedState(page)
  ok('беседа реально стримит', streaming?.streaming === true, streaming?.streaming)
  ok('фид непустой', s2.populated, s2)
  ok('«готов» скрыта пока агент отвечает', !s2.ready, s2)
  if (shots) await page.screenshot({ path: join(shots, 'ready-2-streaming.png') })
  await waitIdle(page, id)

  console.log('\n[3] Гейт ждёт решения — строка молчит')
  const idGate = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a tool please'))
  await page.waitForTimeout(900) // fake поднимает гейт на 400мс
  const gated = await convById(page, idGate)
  const s3 = await feedState(page)
  ok('гейт поднят', (gated?.pendingTools || []).some((t) => !t.settled), gated?.pendingTools?.length)
  ok('фид непустой', s3.populated, s3)
  ok('«готов» скрыта пока гейт ждёт', !s3.ready, s3)
  if (shots) await page.screenshot({ path: join(shots, 'ready-3-gate.png') })

  console.log('\n[4] Ход вернулся человеку — строка вернулась')
  await page.evaluate(() => window.__zaryaApproveFirst?.())
  await waitIdle(page, idGate)
  await page.waitForTimeout(400)
  const s4 = await feedState(page)
  ok('«готов» вернулась после завершения хода', s4.ready, s4)
  if (shots) await page.screenshot({ path: join(shots, 'ready-4-back.png') })

  console.log(`\nИтог: ${pass} ✓ / ${fail} ✗`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
