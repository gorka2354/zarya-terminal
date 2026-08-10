/**
 * Что инструмент сделал на самом деле (inc-27) — на живом окне.
 *
 * Оборванная по времени команда, прочитанный наполовину файл и обрезанный поиск
 * выглядели в ленте так же, как успешные: «✓ готово». Движок присылает
 * разобранный итог рядом с текстовым, и там сказано иначе.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-facts-'))
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
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'факты'))
  await page.waitForTimeout(2200)

  const facts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.zy-mf-tool-fact')).map((e) => ({
      text: e.textContent ?? '',
      warn: e.className.includes('--warn')
    }))
  )

  console.log('\n[1] Неполнота названа словами, а не спрятана')
  ok('строки фактов есть', facts.length >= 3, facts)
  const timeout = facts.find((f) => /по времени/i.test(f.text))
  ok('обрыв по времени назван со сроком', /120/.test(timeout?.text ?? ''), timeout)
  ok('и это предупреждение, а не справка', timeout?.warn === true, timeout)

  const part = facts.find((f) => /прочитано/i.test(f.text))
  ok('частичное чтение названо обеими цифрами', /200.*4000/.test(part?.text ?? ''), part)
  ok('и тоже предупреждение', part?.warn === true, part)

  console.log('\n[2] Обычная цифра остаётся обычной')
  const grep = facts.find((f) => /совпадений/i.test(f.text))
  ok('счёт совпадений показан', /12/.test(grep?.text ?? ''), grep)
  ok('но приглушённо — тревожить тут нечем', grep?.warn === false, grep)

  console.log('\n[3] Незнакомый факт не выводит служебное имя')
  const raw = facts.find((f) => /fact\./.test(f.text))
  ok('ключа словаря на экране нет', raw === undefined, raw)

  console.log('\n[4] Заголовок итога не спорит со строкой под ним')
  // Зелёная галочка с подписью «готово» прямо над «оборвано по времени» — та же
  // ложь, только этажом выше, чем строка успевает её исправить.
  const heads = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('.zy-mf-tool-done, .zy-mf-tool-partial, .zy-mf-outcome-head')
    ).map((e) => ({ text: e.textContent ?? '', cls: e.className }))
  )
  const cut = heads.find((h) => /tests running/.test(h.text))
  ok('итог оборванной команды читается', !!cut, heads.map((h) => h.text))
  ok('но «готово» над «оборвано» не написано', !/готово/.test(cut?.text ?? ''), cut)
  ok('и галочки успеха там нет', !/✓/.test(cut?.text ?? ''), cut)
  ok('помечен он как неполный', /zy-mf-tool-partial/.test(cut?.cls ?? ''), cut)
  const fine = heads.find((h) => /hi/.test(h.text))
  ok('а полный итог остался зелёным и «готово»', /готово/.test(fine?.text ?? ''), fine)
  if (shots) await page.screenshot({ path: join(shots, 'tool-facts.png') })

  console.log(`\n[tool-facts] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: без этого блока упавший прогон
  // печатал «провалено 0» и выходил с нулём — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
