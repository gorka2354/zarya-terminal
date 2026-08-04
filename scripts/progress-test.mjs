/**
 * Видно ли, что работа идёт.
 *
 * Две вещи, которых в ленте не было: строка скачивания у команды (загрузчик
 * перерисовывает её возвратом каретки, и в ленте это читалось как прыгающие
 * цифры) и время у инструмента агента (карточка показывала спиннер и слово
 * «выполняется» — ни секунды, ни строчки вывода, потому что вывод инструмента
 * приходит одним куском в конце).
 *
 * Прогон проверяет обе, а заодно то, что полоса НЕ появляется на обычном
 * выводе: полоса, нарисованная по случайным «100%» в отчёте о покрытии, обещает
 * человеку происходящее, которого нет.
 *
 *   npm run build && node scripts/progress-test.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-progress-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } }, null, 2)
)

let pass = 0
let fail = 0
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
  env: { ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }), ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  const seed = (out, cmd) =>
    page.evaluate(
      ([o, c]) => {
        const sid = window.__zaryaDumpSessions().activeSessionId
        return window.__zaryaSeedRunningBlock(sid, o, c)
      },
      [out, cmd]
    )
  const bar = () =>
    page.evaluate(() => {
      const box = document.querySelector('.zy-mf-progress')
      const fill = document.querySelector('.zy-mf-progress-fill')
      return {
        есть: !!box,
        текст: box?.querySelector('.zy-mf-progress-text')?.textContent?.trim() ?? null,
        ширина: fill ? fill.style.width : null,
        неизвестно: !!document.querySelector('.zy-mf-progress-fill--unknown')
      }
    })

  console.log('\n[1] Строка скачивания у команды')
  await seed(
    'Cloning into "repo"...\nremote: Enumerating objects: 1240, done.\nReceiving objects:  35% (434/1240), 12.4 MiB | 3.2 MiB/s',
    'git clone https://example.com/repo.git'
  )
  await page.waitForTimeout(500)
  let b = await bar()
  ok('полоса появилась', b.есть, b)
  ok('процент из вывода', b.ширина === '35%', b.ширина)
  ok('подпись говорит, чем занят', /Receiving objects/.test(b.текст ?? ''), b.текст)
  ok('и с какой скоростью', /3\.2 MiB\/s/.test(b.текст ?? ''), b.текст)

  console.log('\n[2] Полоса идёт за выводом')
  await seed(
    'Receiving objects:  91% (1128/1240), 30.1 MiB | 3.4 MiB/s',
    'git clone https://example.com/repo.git'
  )
  await page.waitForTimeout(400)
  b = await bar()
  ok('процент обновился', b.ширина === '91%', b.ширина)

  console.log('\n[3] Загрузка без процентов не выдумывает долю пути')
  await seed('Downloading layer [====>      ]  12.3MB/45.6MB', 'docker pull node:22')
  await page.waitForTimeout(400)
  b = await bar()
  ok('полоса есть', b.есть, b)
  ok('ширину не выдумываем — бегунок', b.неизвестно, b)
  ok('объём назван', /12\.3MB\/45\.6MB/.test(b.текст ?? ''), b.текст)

  console.log('\n[4] Обычный вывод полосой не становится')
  await seed('npm warn deprecated core-js@2.6.12\nStatements   : 100% ( 42/42 )', 'npm test')
  await page.waitForTimeout(400)
  ok(
    'на отчёте о покрытии полосы нет',
    await page.evaluate(() => !document.querySelector('.zy-mf-progress'))
  )

  console.log('\n[5] Инструмент агента говорит, сколько уже идёт')
  await page.evaluate(() => window.__zaryaSetUi?.({ barMode: 'codex' }))
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'run a slow tool please'))
  await page.waitForTimeout(1400)
  ok(
    'гейт показан до решения',
    await page.evaluate(() => !!document.querySelector('.zy-mf-tool'))
  )
  // Пока гейт ждёт решения, команда закреплена целиком, и подпись живёт в
  // заголовке карточки (.zy-mf-tool-ask); у свёрнутой она справа (.zy-mf-tool-note).
  const wantsBefore = await page.evaluate(() => {
    const el = document.querySelector('.zy-mf-tool-ask, .zy-mf-tool-note')
    return el?.textContent?.trim() ?? null
  })
  ok('и говорит, что агент ХОЧЕТ выполнить', !!wantsBefore, wantsBefore)

  await page.evaluate(() => window.__zaryaApproveFirst?.())
  await page.waitForTimeout(1300)
  const t1 = await page.evaluate(() => ({
    карточка: !!document.querySelector('.zy-mf-tool'),
    время: document.querySelector('.zy-mf-tool-elapsed')?.textContent?.trim() ?? null,
    хочет: document.querySelector('.zy-mf-tool-ask, .zy-mf-tool-note')?.textContent?.trim() ?? null
  }))
  // Раньше карточка исчезала в момент одобрения: у движков без tool_use (Codex,
  // Gemini, Kimi, Qwen) команда шла, а лента молчала.
  ok('карточка осталась после одобрения', t1.карточка, t1)
  ok('время идёт', /\d+с/.test(t1.время ?? ''), t1.время)
  ok('«хочет выполнить» убрано — команда уже идёт', t1.хочет === null, t1.хочет)

  await page.waitForTimeout(2600)
  const t2 = await page.evaluate(
    () => document.querySelector('.zy-mf-tool-elapsed')?.textContent?.trim() ?? null
  )
  const sec = (v) => Number(/(\d+)\s*с/.exec(v ?? '')?.[1] ?? -1)
  ok('и тикает, а не застыло', sec(t2) > sec(t1.время), { было: t1.время, стало: t2 })

  console.log('\n[6] Ни ошибок, ни предупреждений в консоли')
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForTimeout(400)
  ok('консоль чистая', errors.length === 0, errors.slice(0, 3))
} finally {
  await app.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* каталог мог не создаться */
  }
}

console.log(`\n[progress] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
