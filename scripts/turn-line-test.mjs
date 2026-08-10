/**
 * Итог хода называет себя (inc-24).
 *
 * Три вещи проверяются на живом окне: строка появляется, когда ход кончился не
 * по-хорошему; она называет причину словами (а не «ошибка») и числа; и её НЕТ
 * под обычным быстрым ответом — иначе она превратится в шум под каждой репликой
 * и её перестанут читать.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-turn-'))
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
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    NODE_ENV: 'production'
  }
})

const turnLine = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.zy-mf-turn')
    if (!el) return null
    return {
      reason: el.querySelector('.zy-mf-turn-reason')?.textContent ?? '',
      stats: el.querySelector('.zy-mf-turn-stats')?.textContent ?? '',
      bad: el.className.includes('--bad')
    }
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  console.log('\n[1] Обычный быстрый ответ строки итога НЕ получает')
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2500)
  ok('строки нет', (await turnLine(page)) === null, await turnLine(page))

  console.log('\n[2] Ход, кончившийся не по-хорошему, объясняется')
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'итог хода'))
  await page.waitForTimeout(2500)
  const line = await turnLine(page)
  ok('строка появилась', !!line, line)
  ok('причина названа словами, а не токеном', /шаг|steps/i.test(line?.reason ?? ''), line?.reason)
  ok('не английский токен', !/max_turns/.test(line?.reason ?? ''), line?.reason)
  ok('длительность показана', /74/.test(line?.stats ?? ''), line?.stats)
  ok('время до первого токена показано', /2[.,]6/.test(line?.stats ?? ''), line?.stats)
  ok('шаги показаны', /12/.test(line?.stats ?? ''), line?.stats)
  ok('отклонённые вызовы показаны', /2/.test(line?.stats ?? ''), line?.stats)
  ok('плохой исход отмечен цветом', line?.bad === true, line)

  if (shots) await page.screenshot({ path: join(shots, 'turn-line.png') })
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  process.exit(fail ? 1 : 0)
}
