/**
 * Гейт ждёт решения, а человек пишет в строку.
 *
 * ПОВОД — живой случай владельца. Карточка разрешения висела с `rm -rf`, он
 * вместо нажатия написал сообщение, и панель подменила себя пустой беседой:
 * разговор на 615 сообщений остался цел на диске и в списке «АГЕНТЫ · ЖДЁТ», но
 * ушёл с экрана без единой строки объяснения. Выглядит ровно как потеря работы.
 *
 * Сходились два дефекта: строка судила о занятости по `settled` (то есть
 * наоборот — одобренный гейт считала занятостью, а ждущий решения не считала),
 * поэтому сообщение не попадало в очередь; а `askAgent` сваливал в «завести
 * новую» всё, что не подошло под «продолжить». Проверяем ЖИВЬЁМ и путём
 * человека: печатаем в строку и жмём Enter, а не зовём отправку хуком.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-gq-'))
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
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

/** Беседа панели так, как её видит сама панель. */
const paneConv = (page, sid) => page.evaluate((s) => window.__zaryaConvFor?.(s), sid)
/** Состояние активной беседы: гейты, очередь, лента. */
const dump = (page) => page.evaluate(() => window.__zaryaDumpConv?.())

/** Ждать, пока в беседе появится гейт, ждущий решения. */
async function waitGate(page, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const d = await dump(page)
    if (d?.pendingTools?.some((t) => !t.settled)) return d
    await page.waitForTimeout(300)
  }
  return null
}

/**
 * Напечатать в строку панели и отправить — ровно как человек.
 *
 * Печатаем С КЛАВИАТУРЫ в сфокусированное поле, а не `fill` по селектору: строк
 * ввода на экране может быть несколько, `fill` берёт первую попавшуюся, и текст
 * уходил мимо той строки, которую читают горячие клавиши. Enter тогда видел
 * пустое поле и ОДОБРЯЛ висящий гейт — то есть прогон проверял не то, что думал.
 */
async function type(page, text) {
  await page.click('.zy-agentbar-input')
  const focused = await page.evaluate(() =>
    (document.activeElement?.className ?? '').includes('zy-agentbar-input')
  )
  if (!focused) throw new Error('строка ввода не получила фокус')
  await page.keyboard.type(text)
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(500)

  console.log('\n[1] Ход начат, карточка разрешения ждёт решения')
  await type(page, 'tool danger — покажи карточку и жди')
  const gated = await waitGate(page)
  ok('гейт появился', !!gated, gated && { pending: gated.pendingTools?.length })
  const before = await paneConv(page, sid)
  ok('беседа у панели есть', !!before?.id, before)
  const convId = before?.id
  const msgsBefore = before?.msgs ?? 0

  console.log('\n[2] Строка честно говорит, что занята')
  const placeholder = await page.getAttribute('.zy-agentbar-input', 'placeholder')
  // Это `bar.busy` — «Агент работает — Enter поставит в очередь…». До правки
  // строка считала занятой беседу с ОДОБРЕННЫМ гейтом и свободной — с ждущим
  // решения, поэтому здесь стояла обычная подсказка «Спросить…».
  ok(
    'подсказка называет занятость и обещает очередь',
    /очередь|queue/i.test(placeholder ?? ''),
    placeholder
  )

  console.log('\n[3] Человек пишет ВМЕСТО нажатия — панель не подменяет беседу')
  const snap = async (p, when) => {
    const s = await p.evaluate(() => {
      const d = window.__zaryaDumpConv?.()
      return {
        bars: Array.from(document.querySelectorAll('.zy-agentbar-input')).map((el) => el.value),
        pending: (d?.pendingTools ?? []).map((t) => ({ id: t.id, settled: !!t.settled })),
        queued: d?.queued ?? null,
        streaming: !!d?.streaming
      }
    })
    console.log(`   ${when}:`, JSON.stringify(s))
    return s
  }
  await snap(page, 'перед вводом')
  await page.click('.zy-agentbar-input')
  await snap(page, 'после клика в строку')
  await page.keyboard.type('а вот это что за окно?')
  await page.waitForTimeout(200)
  await snap(page, 'после набора текста')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await snap(page, 'сразу после Enter')
  await page.waitForTimeout(1200)
  const after = await paneConv(page, sid)
  ok('беседа панели ТА ЖЕ', after?.id === convId, { before: convId, after: after?.id })
  ok('лента не обрезалась', (after?.msgs ?? 0) >= msgsBefore, {
    was: msgsBefore,
    now: after?.msgs
  })
  const d = await dump(page)
  ok('карточка всё ещё ждёт решения', !!d?.pendingTools?.some((t) => !t.settled), {
    pending: d?.pendingTools?.length,
    settled: d?.pendingTools?.map((t) => t.settled)
  })
  ok('написанное встало в очередь, а не пропало', /что за окно/.test(d?.queued ?? ''), d?.queued)

  console.log('\n[4] Очередь можно забрать назад — как в CLI')
  // Проверяем именно ОЧЕРЕДЬ, а не историю ввода: без этой проверки ↑ вытащил бы
  // последнее отправленное и тест зеленел бы при пустой очереди.
  const hadQueue = !!d?.queued
  await page.click('.zy-agentbar-input')
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(400)
  const back = await page.inputValue('.zy-agentbar-input')
  const d2 = await dump(page)
  ok('↑ вернул в строку именно приписку из очереди', hadQueue && /что за окно/.test(back), {
    hadQueue,
    back
  })
  ok('и очередь опустела', hadQueue && !d2?.queued, d2?.queued)

  console.log('\n[5] Карточку по-прежнему можно решить — гейт никуда не делся')
  // Условие «гейт был» обязательно: без него проверка зеленела бы и там, где
  // гейт исчез сам, — то есть ровно в сломанном случае.
  const gateBeforeEsc = !!d?.pendingTools?.some((t) => !t.settled)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const d3 = await dump(page)
  ok('Esc отклонил висевший гейт', gateBeforeEsc && !d3?.pendingTools?.some((t) => !t.settled), {
    gateBeforeEsc,
    pending: d3?.pendingTools?.length
  })

  console.log(`\nИтог: ${pass} прошло, ${fail} провалено`)
} catch (e) {
  fail++
  console.log('  ✗ прогон упал:', e?.message ?? e)
} finally {
  await app.close().catch(() => {})
  // Прогон не оставляет за собой профиль — временная папка своя и уходит с ним.
  rmSync(userData, { recursive: true, force: true })
}

process.exit(fail ? 1 : 0)
