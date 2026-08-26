/** Screenshot of the bottom bar — collapsed and with the usage panel open. */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const out = process.env.SHOT_DIR || join(root, 'shots')
const userData = mkdtempSync(join(tmpdir(), 'zarya-bar-'))

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      // Подставной движок: снимку нужен НАСТОЯЩИЙ ход, а не подсеянное
      // состояние — заполнение контекста и подпись модели живут в беседе
      // панели, и выдумать их снаружи больше нельзя.
      ZARYA_FAKE_AGENT: '1', ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)

  // Лимиты подписки — общее состояние окна, его сеем: живого аккаунта в
  // прогоне нет, а без них полоса показывала бы «без лимита».
  await page.evaluate(() => {
    window.__zaryaSetUi?.({
      claudeStatus: {
        usage: {
          subscriptionType: 'Max',
          fiveHourPct: 14,
          fiveHourResetsAt: Date.now() + 3 * 3600e3 + 2 * 60e3,
          sevenDayPct: 18,
          sevenDayResetsAt: Date.now() + 4 * 24 * 3600e3
        }
      }
    })
  })
  /*
   * А заполнение контекста, цена и подпись модели берутся у БЕСЕДЫ панели —
   * поэтому делаем настоящий ход подставным движком. Прежде здесь сеялось
   * общее `agentContext`, которого с прошлого выпуска не читает никто: снимок
   * молча выходил без показателя.
   */
  const conv = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2500)
  /*
   * Полоса в ОБЫЧНОМ состоянии — так она выглядит почти всё время: серая шкала
   * контекста рядом с золотыми ячейками расхода подписки. Снимок отдельный
   * именно ради этого соседства: если два показателя в процентах начнут
   * выглядеть одинаково, полоса снова станет кашей, из-за которой контекст
   * когда-то и убрали.
   */
  const stripQuiet = await page.$('.zy-strip')
  await stripQuiet?.screenshot({ path: join(out, 'strip-quiet.png') })
  console.log('→ strip-quiet.png')

  // Порог «почти полно» — состояние, ради которого чип возвращается в саму
  // панель.
  await page.evaluate(
    (id) => window.__zaryaSeedContext?.(id, { pct: 88, tokens: 176000, window: 200000 }),
    conv
  )
  await page.waitForTimeout(700)

  const chips = await page.$('.zy-agentbar-row')
  const cb = await chips.boundingBox()
  await page.screenshot({ path: join(out, 'chips-zoom.png'), clip: { x: cb.x, y: cb.y, width: 200, height: cb.height } })
  console.log('→ chips-zoom.png')
  const bar = await page.$('.zy-agentbar')
  await bar?.screenshot({ path: join(out, 'bar-collapsed.png') })
  console.log('→ bar-collapsed.png')

  // Нижняя полоса окна: топливо подписки, контекст активной панели, цена,
  // подпись модели и вход в пульт. Отдельным снимком — теперь все числа
  // собраны здесь, а ряд чипов над строкой остался органами управления.
  const strip = await page.$('.zy-strip')
  await strip?.screenshot({ path: join(out, 'strip.png') })
  console.log('→ strip.png')

  await page.click('.zy-agentbar-fuel-main')
  await page.waitForTimeout(400)
  // Полосу и раскрытую панель расхода — вместе.
  const box = await strip?.boundingBox()
  if (box) {
    await page.screenshot({
      path: join(out, 'bar-usage.png'),
      clip: {
        x: box.x,
        y: Math.max(0, box.y - 150),
        width: box.width,
        height: box.height + 150
      }
    })
    console.log('→ bar-usage.png')
  }
} finally {
  await app.close()
}
