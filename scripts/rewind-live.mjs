/**
 * ЖИВОЙ прогон отката — против настоящего Claude Code.
 *
 * Всё остальное в инкременте проверено фейковым движком: он повторяет контракт,
 * но не является им. Настоящий CLI может ответить иначе, и три вещи проверить
 * можно ТОЛЬКО им:
 *
 * 1) флаг `--replay-user-messages` действительно доезжает и движок называет id
 *    хода — то есть кнопка отката вообще появляется;
 * 2) `enableFileCheckpointing` действительно заставляет его снимать копии, и
 *    `rewindFiles` действительно возвращает файлы;
 * 3) аренда сессии работает в беседе, поднятой с диска, — там, где живого
 *    процесса нет.
 *
 * ЧТО ЭТОТ ПРОГОН ТРАТИТ. Один-два коротких хода настоящей модели. Промпты
 * узкие и дешёвые: «впиши строку в файл». Откат токенов не стоит вовсе.
 *
 * ГДЕ ОСТАНУТСЯ СЛЕДЫ. Профиль Зари изолирован (свой userData). А копии файлов
 * движок кладёт в НАСТОЯЩИЙ `~/.claude/file-history`: увести его настройки в
 * временную папку нельзя, вместе с ними уедет авторизация. Поэтому прогон
 * просит исключение явно (ZARYA_QA_LIVE_CHECKPOINTS=1) и печатает, что именно
 * останется на диске.
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const note = (...a) => console.log('   ·', ...a)

/* ── Стенд ────────────────────────────────────────────────────────────────
   Мини-проект, похожий на настоящий: git с историей, пара файлов, README.
   История нужна, чтобы панель «что изменилось» имела с чем сравнивать. */
const work = mkdtempSync(join(tmpdir(), 'zarya-live-'))
const userData = mkdtempSync(join(tmpdir(), 'zarya-liveud-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'workspace' },
    ai: { fileCheckpoints: true }
  })
)

const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe', encoding: 'utf8' })
mkdirSync(join(work, 'src'), { recursive: true })
writeFileSync(join(work, 'README.md'), '# Стенд для живого прогона отката\n')
writeFileSync(join(work, 'src', 'notes.txt'), 'первая строка\nвторая строка\n')
writeFileSync(join(work, 'src', 'keep.txt'), 'этот файл агент не трогает\n')
git('init', '-q')
git('config', 'user.email', 'qa@zarya.local')
git('config', 'user.name', 'QA')
git('add', '-A')
git('commit', '-qm', 'стенд: начальное состояние')

const NOTES = join(work, 'src', 'notes.txt')
const BEFORE_AGENT = readFileSync(NOTES, 'utf8')

console.log('СТЕНД')
note('проект:', work)
note('профиль Зари (изолирован):', userData)
note('копии движка лягут в:', join(homedir(), '.claude', 'file-history'))

const histDir = join(homedir(), '.claude', 'file-history')
const histBefore = existsSync(histDir) ? readdirSync(histDir).length : 0

/** Живой запуск: настоящий движок, изолированный профиль, чекпоинты явно. */
async function launch() {
  return electron.launch({
    args: [join(root, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: userData,
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      // Осознанное исключение: копии лягут в настоящий профиль движка, потому
      // что вместе с его настройками уехала бы авторизация.
      ZARYA_QA_LIVE_CHECKPOINTS: '1',
      NODE_ENV: 'production'
    }
  })
}

const text = (page, sel) =>
  page.evaluate(
    (s) =>
      [...document.querySelectorAll(s)]
        .filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
        .map((e) => e.textContent ?? '')
        .join('\n'),
    sel
  )

const clickRewind = (page) =>
  page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const b = [...document.querySelectorAll('.zy-mf-changes-btn')]
      .filter(vis)
      .find((e) => /Откатить файлы/.test(e.textContent ?? ''))
    b?.click()
  })

/** Ждать, пока в беседе перестанет идти ход (или выйдет время). */
async function waitIdle(page, convId, ms = 120000) {
  const started = Date.now()
  for (;;) {
    const st = await page.evaluate((id) => {
      const c = window.__zaryaConvById?.(id)
      return c ? { streaming: c.streaming === true, error: c.error ?? null } : null
    }, convId)
    if (!st) return { gone: true }
    if (!st.streaming) return st
    if (Date.now() - started > ms) return { timeout: true }
    await page.waitForTimeout
      ? await page.waitForTimeout(1000)
      : await new Promise((r) => setTimeout(r, 1000))
  }
}

let app = await launch()
let convId = null

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1240, 860)
    w.center()
  })
  await page.waitForTimeout(3000)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))

  console.log('\n[1] Настоящий Claude Code стартует и правит файл')
  convId = await page.evaluate(
    () =>
      window.__zaryaStartAgent?.(
        'claude-code',
        'Впиши в файл src/notes.txt третью строку: «правка агента». Ничего больше не меняй, не запускай команд и не создавай файлов.'
      )
  )
  await page.waitForTimeout(1500)
  // Автопилот: иначе прогон встанет на карточке одобрения и будет ждать мышь.
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), convId)
  const idle = await waitIdle(page, convId)
  note('ход завершён:', JSON.stringify(idle))
  const afterAgent = readFileSync(NOTES, 'utf8')
  ok('агент действительно изменил файл', afterAgent !== BEFORE_AGENT, {
    было: BEFORE_AGENT,
    стало: afterAgent
  })
  if (shots) await page.screenshot({ path: join(shots, 'live-1-turn.png') })

  console.log('\n[2] Флаг доехал: движок назвал id хода, кнопка появилась')
  const marks = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return { checkpointing: c?.checkpointing === true, turns: c?.turnMarks ?? [] }
  }, convId)
  // Это и есть проверка --replay-user-messages на живом CLI: без него движок
  // не называет id хода, и точка отката не появляется вовсе.
  ok('сессия сообщила, что копии включены', marks.checkpointing === true, marks)
  ok(
    'у хода человека есть точка отката',
    marks.turns.some((m) => m.role === 'user' && m.turnId),
    marks.turns
  )
  const btns = await text(page, '.zy-mf-changes-btn')
  ok('кнопка «Откатить файлы» на экране', /Откатить файлы/.test(btns), btns)

  console.log('\n[3] Человек дописывает в тот же файл — карточка обязана предупредить')
  const MINE = afterAgent + 'моя строка, которую нельзя потерять\n'
  writeFileSync(NOTES, MINE)
  await page.waitForTimeout(500)
  const t0 = Date.now()
  await clickRewind(page)
  await page.waitForTimeout(1200)
  // Сколько человек ждёт карточку — это про удобство, а не про корректность.
  for (let i = 0; i < 30; i++) {
    const c = await text(page, '.zy-rw')
    if (/Файлов:|Движок не назвал|не enabled|not enabled/i.test(c)) break
    await page.waitForTimeout(500)
  }
  note('карточка собралась за', Date.now() - t0, 'мс')
  const card = await text(page, '.zy-rw')
  ok('карточка открылась', /вернутся к состоянию/.test(card), card.slice(0, 300))
  ok('файл агента в списке', /notes\.txt/.test(card), card.slice(0, 400))
  ok(
    'сказано, что моя правка пропадёт',
    /правка пропадёт|правили после хода/.test(card),
    card.slice(0, 500)
  )
  ok('файл, которого агент не трогал, в списке НЕ появился', !/keep\.txt/.test(card), card)
  if (shots) await page.screenshot({ path: join(shots, 'live-2-card.png') })

  console.log('\n[4] Откат: файлы возвращаются, моя правка сохранена копией')
  await page.click('.zy-rw-go')
  await page.waitForTimeout(3000)
  const done = await text(page, '.zy-rw-done')
  note('итог:', done.replace(/\s+/g, ' ').slice(0, 200))
  const onDisk = readFileSync(NOTES, 'utf8')
  // Главная проверка всего инкремента на живом движке: файл вернулся к тому,
  // что было ДО правки агента, и моей строки в нём больше нет.
  ok('файл вернулся к состоянию до правки агента', onDisk === BEFORE_AGENT, {
    ожидали: BEFORE_AGENT,
    получили: onDisk
  })
  ok('в итоге есть числа сверки', /Вернулось/.test(done), done)
  let backups = []
  try {
    backups = readdirSync(join(userData, 'rewind-backup'))
  } catch {
    backups = []
  }
  ok('копия моей правки лежит на диске', backups.length > 0, backups)
  if (backups.length) {
    const dir = join(userData, 'rewind-backup', backups[0])
    const files = readdirSync(dir)
    const saved = files.length ? readFileSync(join(dir, files[0]), 'utf8') : ''
    ok('в копии — именно моя строка', /моя строка/.test(saved), saved.slice(0, 200))
  }
  const feed = await text(page, '.zy-mf-notice')
  ok('в ленте осталась отметка числами', /Файлы откачены/.test(feed), feed)
  if (shots) await page.screenshot({ path: join(shots, 'live-3-done.png') })
} finally {
  await app.close()
}

console.log('\n[5] Аренда сессии: откат в беседе, поднятой с диска после перезапуска')
app = await launch()
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3500)
  // Точка отката должна была уехать на диск вместе с беседой.
  const st = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return c ? { turns: c.turnMarks ?? [], sessionId: c.sessionId ?? null } : null
  }, convId)
  ok('беседа поднялась с диска', !!st, st)
  ok(
    'точка отката пережила перезапуск',
    (st?.turns ?? []).some((m) => m.role === 'user' && m.turnId),
    st?.turns
  )
  if (shots) await page.screenshot({ path: join(shots, 'live-4-restart.png') })
} finally {
  await app.close()
}

const histAfter = existsSync(histDir) ? readdirSync(histDir).length : 0
console.log('\nСЛЕДЫ НА ДИСКЕ')
note('папок в ~/.claude/file-history было', histBefore, '· стало', histAfter)
note('проект прогона остался в', work)

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
