/**
 * Карточка отката на экране.
 *
 * Кнопка «Откатить файлы» ничего не откатывает — она открывает карточку, и
 * весь инкремент существует ради неё. Прогон проверяет не «карточка
 * появилась», а то, ради чего она сделана именно так:
 *
 * 1) кнопки НЕТ там, где откатывать нечем (движок не умеет, у сессии нет
 *    копий, у хода нет точки) — кнопка-обещание дороже её отсутствия;
 * 2) в карточке названы файлы и то, что с ними будет;
 * 3) две строки стоят ВСЕГДА: чего откат не умеет вовсе (оболочка, субагенты,
 *    пакеты) и что сам он необратим;
 * 4) отказ движка показывается ЕГО словами, а не нашим «не получилось»;
 * 5) после отката человек видит числа НАШЕЙ сверки, включая те файлы, до
 *    которых откат не дошёл.
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

async function withApp(mode, fn) {
  const userData = mkdtempSync(join(tmpdir(), 'zarya-card-'))
  const work = mkdtempSync(join(tmpdir(), 'zarya-cardw-'))
  // Копии движка лежат вне подменяемой папки — уводим его настройки к себе,
  // иначе политика (справедливо) выключит чекпоинты и точки отката не будет.
  const claudeHome = mkdtempSync(join(tmpdir(), 'zarya-cardcfg-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
  )
  const app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: userData,
      CLAUDE_CONFIG_DIR: claudeHome,
      ZARYA_FAKE_AGENT: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      ...(mode ? { ZARYA_FAKE_REWIND: mode } : {}),
      NODE_ENV: 'production'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(1180, 800)
      w.center()
    })
    await page.waitForTimeout(2500)
    await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
    await fn(page, work)
  } finally {
    await app.close()
  }
}

/** Прошлые панели остаются в DOM скрытыми — читаем только видимое. */
const text = (page, sel) =>
  page.evaluate(
    (s) =>
      [...document.querySelectorAll(s)]
        .filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
        .map((e) => e.textContent ?? '')
        .join('\n'),
    sel
  )

/** Нажать видимую кнопку отката у последнего хода. */
const clickRewind = (page) =>
  page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const b = [...document.querySelectorAll('.zy-mf-changes-btn')]
      .filter(vis)
      .find((e) => /Откатить файлы/.test(e.textContent ?? ''))
    b?.click()
  })

console.log('\n[1] Кнопка появляется у хода — и только когда откатывать есть чем')
await withApp('ok', async (page) => {
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2200)
  const btns = await text(page, '.zy-mf-changes-btn')
  ok('кнопка отката на экране', /Откатить файлы/.test(btns), btns)
})

console.log('\n[2] У движка без такой способности кнопки нет вовсе')
await withApp('ok', async (page) => {
  // gemini в фейковом наборе намеренно не умеет откат файлов: кнопка там
  // обещала бы то, чего нечем выполнить.
  await page.evaluate(() => window.__zaryaStartAgent?.('gemini', 'привет'))
  await page.waitForTimeout(2200)
  const btns = await text(page, '.zy-mf-changes-btn')
  ok('кнопки отката нет', !/Откатить файлы/.test(btns), btns)
  ok('а «что изменилось» — есть, она работает у всех', /что изменилось/.test(btns), btns)
})

console.log('\n[3] Карточка называет файлы и говорит, чего откат не умеет')
await withApp('ok', async (page) => {
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2200)
  await clickRewind(page)
  await page.waitForTimeout(1600)
  const card = await text(page, '.zy-rw')
  ok('карточка открылась', /вернутся к состоянию/.test(card), card.slice(0, 200))
  ok('файл назван', /fake\.ts/.test(card), card.slice(0, 400))
  // Эти две строки стоят всегда: первая — про самый частый способ агента
  // изменить мир, вторая — про то, что у движка нет «до отката».
  ok('сказано про оболочку и субагентов', /Команды оболочки/.test(card), card)
  ok('сказано, что откат необратим', /отменить нельзя/.test(card), card)
  ok('сказано, что разговор останется как есть', /Разговор останется/.test(card), card)
  if (shots) await page.screenshot({ path: join(shots, 'rewind-card.png') })

  console.log('\n[4] После отката — числа НАШЕЙ сверки, а не рапорт движка')
  await page.click('.zy-rw-go')
  await page.waitForTimeout(1800)
  const done = await text(page, '.zy-rw-done')
  ok('итог показан числами', /Вернулось/.test(done), done)
  // Фейк на диске ничего не менял: файл остался прежним, и об этом сказано.
  ok('файл, до которого не дошло, посчитан', /осталось прежними: 1/.test(done), done)
  ok('и назван', /fake\.ts/.test(done), done)
  if (shots) await page.screenshot({ path: join(shots, 'rewind-done.png') })
})

console.log('\n[5] Отказ движка показан ЕГО словами')
await withApp('off', async (page) => {
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2200)
  await clickRewind(page)
  await page.waitForTimeout(1600)
  const refuse = await text(page, '.zy-rw-refuse')
  ok('причина названа словами движка', /not enabled/i.test(refuse), refuse)
  // Кнопки «Откатить» в этом состоянии быть не должно: нажимать нечего.
  const go = await page.evaluate(
    () =>
      [...document.querySelectorAll('.zy-rw-go')].filter((el) =>
        el.checkVisibility ? el.checkVisibility() : !!el.offsetParent
      ).length
  )
  ok('кнопки «Откатить» нет', go === 0, go)
  if (shots) await page.screenshot({ path: join(shots, 'rewind-refused.png') })
})

console.log('\n[6] Правку человека поверх агента карточка называет ДО отката')
await withApp('ok', async (page, work) => {
  // Ровно тот случай, ради которого весь инкремент: агент записал файл,
  // человек дописал в него руками, и родной откат снёс бы дописанное молча —
  // сухой прогон движка об этом не предупреждает вовсе.
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(1200)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), cid)
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__zaryaFollowUp?.('tool edit: поправь файл'))
  await page.waitForTimeout(2400)

  // Человек правит тот же файл руками — как в терминале рядом.
  writeFileSync(join(work, 'src', 'shared', 'fake.ts'), 'const a = 42\nMY OWN LINE\n')
  await page.waitForTimeout(300)

  await clickRewind(page)
  await page.waitForTimeout(1800)
  const card = await text(page, '.zy-rw')
  ok('карточка предупреждает о потере правки', /правка пропадёт|правили после хода/.test(card), card.slice(0, 500))
  ok('и не называет файл спокойным «вернётся»', !/вернётся к прежнему виду/.test(card), card.slice(0, 500))
  if (shots) await page.screenshot({ path: join(shots, 'rewind-human-edit.png') })
})

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
