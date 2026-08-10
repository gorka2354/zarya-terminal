/**
 * Вызов, который печатается на глазах (inc-27) — на живом окне.
 *
 * Посимвольно в Заре шёл только текст ответа. Когда модель сочиняет ВЫЗОВ,
 * текста нет вовсе — и на длинной команде человек десять секунд смотрел на три
 * точки, не отличая «пишет» от «завис». Проверяем и обратное: строка обязана
 * УЙТИ, когда придёт настоящая карточка, а не остаться висеть над ней.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-typing-'))
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

const line = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.zy-mf-typing-tool')
    if (!el) return null
    return {
      name: el.querySelector('.zy-mf-typing-tool-name')?.textContent ?? '',
      arg: el.querySelector('.zy-mf-typing-tool-arg')?.textContent ?? '',
      spinner: !!el.querySelector('.zy-mf-spinner')
    }
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'набор аргументов'))
  await page.waitForTimeout(700)

  console.log('\n[1] Видно, что агент набирает вызов, а не завис')
  const first = await line(page)
  ok('строка набора на экране', !!first, first)
  ok('инструмент назван', first?.name === 'Bash', first)
  ok('и видно, что работа идёт', first?.spinner === true, first)
  ok('аргумент показан таким, каким набран', /npm ru/.test(first?.arg ?? ''), first)

  const dots = await page.evaluate(
    () => !!document.querySelector('.zy-mf-typing:not(.zy-mf-typing-tool)')
  )
  ok('обычных «отвечает…» рядом нет — два индикатора врали бы вдвоём', dots === false)

  console.log('\n[2] Аргумент дописывается на глазах')
  await page.waitForTimeout(1100)
  const grown = await line(page)
  ok(
    'строка стала длиннее, а не застыла',
    (grown?.arg?.length ?? 0) > (first?.arg?.length ?? 0),
    { было: first?.arg, стало: grown?.arg }
  )
  if (shots) await page.screenshot({ path: join(shots, 'tool-typing.png') })

  console.log('\n[3] Настоящая карточка занимает то же место, а строка уходит')
  await page.waitForTimeout(2600)
  const gone = await line(page)
  ok('строка набора снята', gone === null, gone)
  const card = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-cmd')?.textContent ?? ''
  )
  ok('карточка на её месте', /npm run build --if-present/.test(card), card)
  const outcome = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-done, .zy-mf-tool-partial')?.textContent ?? ''
  )
  ok('и с итогом', /собрано/.test(outcome), outcome)

  console.log(`\n[tool-typing] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
