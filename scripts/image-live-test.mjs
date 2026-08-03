/**
 * Вставка изображения — на НАСТОЯЩЕМ Claude Code (нужна живая авторизация Max).
 *
 * Фейковый движок картинку принимает, но не смотрит на неё: он вернёт свой
 * ответ независимо от содержимого. Доказать, что изображение доехало до модели и
 * что она его ВИДИТ, можно единственным способом — написать на картинке слово,
 * которого нет ни в одном контексте, и спросить, что на ней.
 *
 * Стоит один короткий ход подписки. Запускать руками:
 *   node scripts/image-live-test.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORD = 'ЛАЗУРЬ-77'
const userData = mkdtempSync(join(tmpdir(), 'zarya-imglive-'))
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
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

try {
  const w = await app.firstWindow()
  await w.waitForLoadState('domcontentloaded')
  await w.waitForTimeout(3500)
  await w.evaluate(() => window.__zaryaSetUi?.({ barMode: 'claude-code' }))
  await w.waitForTimeout(500)

  console.log('\n[1] Вставляем картинку со словом, которого нет в контексте')
  const attached = await w.evaluate(async (word) => {
    const c = new OffscreenCanvas(900, 500)
    const x = c.getContext('2d')
    x.fillStyle = '#ffffff'
    x.fillRect(0, 0, 900, 500)
    x.fillStyle = '#101010'
    x.font = 'bold 90px sans-serif'
    x.fillText(word, 90, 280)
    const blob = await c.convertToBlob({ type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'word.png', { type: 'image/png' }))
    const ta = document.querySelector('.zy-agentbar-input')
    ta.focus()
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 1800))
    const sid = window.__zaryaDumpSessions().activeSessionId
    return (window.__zaryaPendingImages(sid) ?? []).length
  }, WORD)
  ok('вложение принято', attached === 1, attached)

  console.log('\n[2] Спрашиваем, что на картинке — это и есть проверка')
  const convId = await w.evaluate(async () => {
    const ta = document.querySelector('.zy-agentbar-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'Какое слово написано на картинке? Ответь только этим словом.')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 1500))
    const sid = window.__zaryaDumpSessions().activeSessionId
    return window.__zaryaConvFor(sid)?.id ?? null
  })
  ok('ход отправлен', !!convId, convId)

  // Живой агент неспешен: ждём конца хода, а не «столько-то миллисекунд».
  const dl = Date.now() + 120_000
  let conv = null
  while (Date.now() < dl) {
    conv = await w.evaluate((id) => window.__zaryaConvById(id), convId)
    if (conv && conv.streaming === false && (conv.text ?? '').includes('картинке')) {
      // ответ пришёл после нашего вопроса
      const tail = (conv.text ?? '').split('Ответь только этим словом.').pop() ?? ''
      if (tail.trim()) break
    }
    await w.waitForTimeout(1500)
  }
  const answer = (conv?.text ?? '').split('Ответь только этим словом.').pop() ?? ''
  ok('агент ответил', answer.trim().length > 0, answer.slice(0, 160))
  ok(
    `модель ПРОЧИТАЛА слово с картинки (${WORD})`,
    new RegExp(WORD.replace('-', '[-\\s]?'), 'i').test(answer),
    answer.slice(0, 200)
  )
  ok('вложение снято после отправки', (conv?.text ?? '').includes('[Изображение #1]'), (conv?.text ?? '').slice(0, 120))

  console.log(`\n[image-live] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
