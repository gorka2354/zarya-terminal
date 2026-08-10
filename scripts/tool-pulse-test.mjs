/**
 * Пульс инструмента (inc-27) — на живом окне.
 *
 * Секундомер карточки идёт одинаково у работающей команды и у повисшей. Пульс
 * движка их различает: пока он идёт — точка на карточке, пропал — сказано
 * словами. Проверяем оба конца, и второй — настоящим ожиданием: порог тишины
 * считается по наблюдённому ритму, и подделать его здесь значило бы проверить
 * не ту логику.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-pulse-'))
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
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'пульс с повтором'))
  await page.waitForTimeout(2800)

  console.log('\n[1] Пока пульс идёт — видно, что вызов жив')
  const beat = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-tool-beat')
    return el ? { title: el.getAttribute('title') ?? '' } : null
  })
  ok('отметка живого пульса на карточке', !!beat, beat)
  ok('она объясняет себя наведением', /подтвержда/i.test(beat?.title ?? ''), beat?.title)

  const quietEarly = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-quiet')?.textContent ?? null
  )
  ok('о пропаже пульса пока НЕ сказано', quietEarly === null, quietEarly)

  const retry = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-retry')?.textContent ?? ''
  )
  ok('повтор подзадачи назван числами', /2\D+3/.test(retry), retry)

  const running = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-exec')?.textContent ?? ''
  )
  ok('карточка при этом всё ещё «идёт»', running.length > 0 && !/✓|✗/.test(running), running)
  if (shots) await page.screenshot({ path: join(shots, 'tool-pulse-alive.png') })

  console.log('\n[2] Пульс пропал — сказано словами (ждём порог по-настоящему)')
  // Нижний порог тишины — 30 с (PULSE_QUIET_FLOOR_MS). Ждём с запасом: карточка
  // перерисовывается раз в секунду, и новость должна появиться сама.
  await page.waitForTimeout(34_000)
  const quiet = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-tool-quiet')
    return el ? { text: el.textContent ?? '', title: el.getAttribute('title') ?? '' } : null
  })
  ok('строка о пропавшем пульсе появилась', !!quiet, quiet)
  ok('в ней названо, сколько длится тишина', /\d/.test(quiet?.text ?? ''), quiet?.text)
  ok('и сказано, что с этим делать', /прерв/i.test(quiet?.title ?? ''), quiet?.title)
  const beatGone = await page.evaluate(() => !!document.querySelector('.zy-mf-tool-beat'))
  ok('отметка «жив» при этом снята', beatGone === false)
  if (shots) await page.screenshot({ path: join(shots, 'tool-pulse-lost.png') })

  console.log(`\n[tool-pulse] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
