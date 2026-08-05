/**
 * Задачи агента и печать ответа — то, о чём лента до сих пор молчала или врала.
 *
 * ПЕРВОЕ — волна задач. Драйвер глушил НАВСЕГДА всё, у чего род не
 * `local_agent`: под тот же нож попал `Workflow` (род `local_workflow`), и
 * человек видел «запущено в фоне», а дальше тишину. Заодно не читался исход:
 * упавшей, остановленной и успешной задаче рисовался один зелёный чек — «18 из
 * 18» при двух упавших было обычным делом. Это не недосказанность, а
 * утверждение, что всё получилось, когда не получилось.
 *
 * ВТОРОЕ — печать. `includePartialMessages` стоял в `false`, и на длинном
 * ответе человек смотрел на три точки, пока весь текст не прилетал разом: по
 * экрану нельзя было отличить «пишет» от «завис».
 *
 * Здесь проверяется обе половины печати: что она видна и что куски НЕ оседают в
 * истории. Второе важнее первого — иначе оборванный на середине поток остался
 * бы в беседе как ответ агента, и следующий ход унёс бы полфразы в контекст.
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-wave-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-wavew-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

/**
 * Снимок экрана — удобство, а не проверка.
 *
 * У окна, уехавшего за край экрана, съёмка изредка срывается на стороне
 * браузера. Ронять из-за этого весь прогон нельзя: тогда не видно НИ ОДНОЙ
 * настоящей проверки — ровно того, ради чего он и запускается.
 */
const shot = async (page, name) => {
  if (!shots) return
  try {
    await page.screenshot({ path: join(shots, `${name}.png`) })
  } catch (e) {
    console.log('  ~ снимок', name, 'не вышел:', String(e.message).split('\n')[0])
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
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1100, 760)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.waitForTimeout(600)

  console.log('\n[1] Пока волна идёт — видно, кто чем занят')
  await page.evaluate(() => window.__zaryaAskAgent?.('покажи волну', 'codex'))
  await page.waitForTimeout(1200) // между «progress» (900мс) и исходами (1700мс)
  const live = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-wave')
    if (!el) return null
    return {
      count: el.querySelector('.zy-mf-wave-count')?.textContent ?? '',
      rows: [...el.querySelectorAll('.zy-mf-wave-row')].map((r) => r.textContent ?? ''),
      bg: !!el.querySelector('.zy-mf-wave-bg')
    }
  })
  ok('волна на экране', !!live, live)
  // Воркфлоу раньше не показывался ВООБЩЕ: белый список драйвера глушил его
  // навсегда. Это главная проверка первой половины прогона.
  ok('воркфлоу назван своим именем', /review-changes/.test((live?.rows ?? []).join(' ')), live?.rows)
  // И раз в волне не одни агенты, счётчик обязан звать их задачами: воркфлоу,
  // названный агентом, — то же враньё, только мельче.
  ok('счётчик говорит «задач», а не «агентов»', /задач/.test(live?.count ?? ''), live?.count)
  ok('ушедшая в фон помечена', live?.bg === true, live)
  await shot(page, 'wave-live')

  console.log('\n[2] Когда всё кончилось — исход у каждой свой')
  await page.waitForTimeout(1400)
  const settled = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-wave')
    if (!el) return null
    return {
      cls: el.className,
      count: el.querySelector('.zy-mf-wave-count')?.textContent ?? '',
      bad: el.querySelector('.zy-mf-wave-bad')?.textContent ?? '',
      check: !!el.querySelector('.zy-mf-wave-head svg'),
      badMark: !!el.querySelector('.zy-mf-wave-bad-mark'),
      spinner: !!el.querySelector('.zy-mf-wave-head .zy-mf-spinner'),
      failed: [...el.querySelectorAll('.zy-mf-wave-row--failed')].map((r) => r.textContent ?? ''),
      stopped: [...el.querySelectorAll('.zy-mf-wave-row--stopped')].map((r) => r.textContent ?? '')
    }
  })
  ok('упавшая задача на виду', settled?.failed.length === 1, settled?.failed)
  // Слова о неудаче — движка. Своих у нас нет, и придумывать их нельзя.
  ok(
    'и сказано, ПОЧЕМУ не вышло',
    /не нашёл package[.]json/.test((settled?.failed ?? []).join(' ')),
    settled?.failed
  )
  ok('остановленная отделена от упавшей', settled?.stopped.length === 1, settled?.stopped)
  ok('сказано, сколько не смогло', /не смогли: 2/.test(settled?.bad ?? ''), settled?.bad)
  // Галочка означает «всё получилось». С двумя упавшими это ложь значком при
  // честных цифрах — самое незаметное враньё из возможных.
  ok('галочки «всё хорошо» нет', settled?.check === false, settled)
  ok('и волна помечена целиком', /zy-mf-wave--bad/.test(settled?.cls ?? ''), settled?.cls)
  // Ход кончился, а ушедшая в фон ещё работает: 3 из 4 и крутилка — это правда.
  // Дорисовать здесь итоговый знак значило бы объявить конец раньше времени.
  ok('счёт ещё не полон — одна в фоне', /3\/4/.test(settled?.count ?? ''), settled?.count)
  ok('и крутилка на месте', settled?.spinner === true, settled)
  await shot(page, 'wave-settled')

  console.log('\n[2b] Когда доработала и фоновая — волна называет итог')
  await page.waitForTimeout(1600)
  const closed = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-wave')
    if (!el) return null
    return {
      count: el.querySelector('.zy-mf-wave-count')?.textContent ?? '',
      check: !!el.querySelector('.zy-mf-wave-head svg'),
      badMark: !!el.querySelector('.zy-mf-wave-bad-mark'),
      spinner: !!el.querySelector('.zy-mf-wave-head .zy-mf-spinner')
    }
  })
  ok('все четыре сочтены', /4\/4/.test(closed?.count ?? ''), closed?.count)
  ok('крутилка ушла', closed?.spinner === false, closed)
  // Галочка означает «всё получилось». С двумя упавшими это ложь значком при
  // честных цифрах — самое незаметное враньё из возможных.
  ok('галочки «всё хорошо» так и нет', closed?.check === false, closed)
  ok('вместо неё — знак неудачи', closed?.badMark === true, closed)
  await shot(page, 'wave-closed')

  console.log('\n[3] Ответ печатается на глазах')
  // Мост, который ОТДАЁТ номер беседы: без него шаг 4 читал бы чужую.
  const convId = await page.evaluate(() =>
    window.__zaryaStartAgent?.('codex', 'печатай ответ')
  )
  await page.waitForTimeout(900) // середина потока
  const mid = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-answer--typing')
    return el
      ? {
          text: el.textContent ?? '',
          caret: !!el.querySelector('.zy-mf-caret'),
          dots: !!document.querySelector('.zy-mf-typing')
        }
      : null
  })
  ok('текст виден до конца ответа', !!mid && mid.text.length > 0, mid)
  ok('и он ещё не весь', !/тест зелёный/.test(mid?.text ?? ''), mid?.text)
  ok('курсор на конце', mid?.caret === true, mid)
  // Три точки — это «пишет, но нечего показать». Когда есть что, они лишние.
  ok('трёх точек рядом нет', mid?.dots === false, mid)
  // Лента обязана следовать за печатью: иначе длинный ответ уезжает под нижний
  // край ровно в тот момент, ради которого печать и показывают.
  // Ждём, пока натечёт текста БОЛЬШЕ экрана: на коротком ответе слежение
  // проверить нечем — он и так весь виден.
  await page.waitForTimeout(400)
  const follow = await page.evaluate(() => {
    // ВИДИМАЯ лента: узлов с этим классом на экране несколько (панели), и у
    // невидимых высота нулевая — на такой «прокрутка внизу» истинна всегда, то
    // есть проверка не проверяла бы ничего.
    const el = [...document.querySelectorAll('.zy-mf-scroll')].find((e) => e.clientHeight > 100)
    if (!el) return null
    return {
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      overflows: el.scrollHeight - el.clientHeight > 40
    }
  })
  // Сначала убеждаемся, что ленте ВООБЩЕ есть куда прокручиваться: на тексте,
  // который помещается целиком, следующая проверка проходит сама собой.
  ok('текста больше, чем экрана', follow?.overflows === true, follow)
  ok('лента внизу — печать не уехала под край', (follow?.gap ?? 999) < 64, follow)
  await shot(page, 'wave-typing')

  console.log('\n[4] Куски печати в историю не ложатся')
  await page.waitForTimeout(2200)
  const after = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    const el = document.querySelector('.zy-mf-answer--typing')
    return {
      typing: !!el,
      answers: document.querySelectorAll('.zy-mf-answer').length,
      last: c?.text ?? ''
    }
  }, convId)
  ok('печать убралась', after.typing === false, after)
  // Ровно ОДИН ответ: кусок и целое сообщение — не два ответа, а один и тот же.
  ok('в ленте один ответ, а не два', after.answers === 1, after.answers)
  ok('и это целый текст движка', /тест зелёный/.test(after.last), after.last.slice(-80))

  console.log(`\n[agent-wave] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)
