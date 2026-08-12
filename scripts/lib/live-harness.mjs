/**
 * Каркас живых прогонов: один сценарий — два движка.
 *
 * Прогоны против настоящего Claude Code дорогие (токены, минуты) и не годятся
 * для CI, а прогоны против фейка дёшевы, но не доказывают ничего про чужую
 * программу. Раньше это были два разных скрипта с разъезжающимися проверками —
 * и именно там пряталась ошибка: фейк отдавал абсолютный путь, настоящий движок
 * относительный, и наш код падал только на живом.
 *
 * Поэтому сценарий пишется ОДИН раз и запускается обоими:
 *
 *   node scripts/live/rewind-basic.mjs           # фейк, быстро, без токенов
 *   ZARYA_LIVE=1 node scripts/live/rewind-basic.mjs   # настоящий Claude Code
 *
 * Всё, что различается между движками, спрятано здесь: имя движка, промпт для
 * правки файла, разрешение на чекпоинты в изолированном запуске.
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Живой режим — только по явному требованию: он тратит токены. */
export const LIVE = process.env.ZARYA_LIVE === '1'
export const ENGINE = LIVE ? 'claude-code' : 'codex'
const SHOTS = process.env.ZARYA_SHOTS || ''

/* ── Счёт проверок ──────────────────────────────────────────────────────── */

let pass = 0
let fail = 0
export const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
  return !!cond
}
/**
 * Пропуск — это НЕ успех.
 *
 * Часть проверок физически невозможна на фейке: он отвечает в протоколе, но
 * файлы на диске не возвращает. Молча их не выполнять значит показать зелёный
 * прогон, который ничего об этом не сказал, — ровно то враньё, против которого
 * весь инкремент.
 */
let skipped = 0
export const skip = (name, why) => {
  skipped++
  console.log('  ⊘', name, '— пропущено:', why)
}
export const note = (...a) => console.log('   ·', ...a)
export const section = (title) => console.log(`\n${title}`)

export function finish() {
  console.log(`\nИтог (${LIVE ? 'живой Claude Code' : 'фейковый движок'}): ${pass} ok, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

/* ── Стенд ──────────────────────────────────────────────────────────────── */

/**
 * Временный проект с историей git.
 *
 * История нужна не для красоты: без коммита панели «что изменилось» не с чем
 * сравнивать, и половина проверок стала бы бессмысленной.
 */
export function makeStand(files, { git: withGit = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'zarya-stand-'))
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(work, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text, 'utf8')
  }
  if (withGit) {
    const git = (...a) => execFileSync('git', a, { cwd: work, stdio: 'pipe', encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'qa@zarya.local')
    git('config', 'user.name', 'QA')
    git('add', '-A')
    git('commit', '-qm', 'стенд: начальное состояние')
  }
  return work
}

export const readWork = (work, rel) => readFileSync(join(work, rel), 'utf8')
export const writeWork = (work, rel, text) => writeFileSync(join(work, rel), text, 'utf8')

/* ── Запуск приложения ──────────────────────────────────────────────────── */

/**
 * Профиль Зари всегда изолирован. С копиями движка сложнее: они лежат вне
 * подменяемой папки, и в живом режиме увести его настройки нельзя — вместе с
 * ними уедет авторизация. Поэтому на фейке уводим (полная изоляция), а в живом
 * просим исключение явно.
 */
export async function launchZarya({ work, userData, settings = {}, editPath } = {}) {
  const ud = userData ?? mkdtempSync(join(tmpdir(), 'zarya-ud-'))
  writeFileSync(
    join(ud, 'settings.json'),
    JSON.stringify({
      appearance: { language: 'ru' },
      sessions: { restoreOnLaunch: 'workspace' },
      ai: { fileCheckpoints: true },
      ...settings
    })
  )
  const claudeHome = LIVE ? undefined : mkdtempSync(join(tmpdir(), 'zarya-cfg-'))
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
      ZARYA_USER_DATA: ud,
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      ...(LIVE
        ? { ZARYA_QA_LIVE_CHECKPOINTS: '1' }
        : {
            ZARYA_FAKE_AGENT: '1',
            CLAUDE_CONFIG_DIR: claudeHome,
            // Фейк правит ТОТ ЖЕ файл, что назвал сценарий: иначе один
            // сценарий на два движка невозможен.
            ...(editPath ? { ZARYA_FAKE_EDIT_PATH: editPath } : {})
          }),
      NODE_ENV: 'production'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1240, 860)
    w.center()
  })
  await page.waitForTimeout(LIVE ? 3000 : 2500)
  if (work) {
    await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
    await page.waitForTimeout(1800)
  }
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  return { app, page, userData: ud }
}

/* ── Работа с агентом ───────────────────────────────────────────────────── */

/**
 * Промпт, заставляющий агента ИЗМЕНИТЬ файл.
 *
 * У фейка сценарий выбирается ключевыми словами, у настоящей модели — обычной
 * просьбой. Единственное место, где эта разница живёт.
 */
export function editPrompt(relPath, line) {
  return LIVE
    ? `Впиши в файл ${relPath} новую строку: «${line}». Ничего больше не меняй, не запускай команд и не создавай файлов.`
    : 'tool edit: поправь файл'
}

/**
 * Начать беседу и дождаться конца хода. Возвращает id беседы.
 *
 * Автопилот включается ДО хода с правкой, а не после: он свойство беседы, и
 * поставленный вдогонку он на уже ушедший ход не действует — движок поднимает
 * карточку одобрения, ход виснет, а прогон получает «идёт ход» вместо
 * результата. Поэтому беседа открывается коротким приветствием, и только
 * потом идёт настоящая просьба.
 */
export async function askAgent(page, prompt, { bypass = true } = {}) {
  const id = await page.evaluate(
    ([e, p]) => window.__zaryaStartAgent?.(e, p),
    [ENGINE, bypass ? 'привет' : prompt]
  )
  await page.waitForTimeout(1000)
  if (!bypass) {
    await waitIdle(page, id)
    return id
  }
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), id)
  await waitIdle(page, id)
  await followUp(page, id, prompt)
  return id
}

/** Продолжить беседу тем же ходом и дождаться конца. */
export async function followUp(page, convId, prompt) {
  await page.evaluate((p) => window.__zaryaFollowUp?.(p), prompt)
  await page.waitForTimeout(800)
  await waitIdle(page, convId)
}

/** Ждать, пока ход не кончится. Живой движок думает дольше фейка. */
export async function waitIdle(page, convId, ms = LIVE ? 180000 : 20000) {
  const started = Date.now()
  for (;;) {
    const st = await page.evaluate((id) => {
      const c = window.__zaryaConvById?.(id)
      return c ? { streaming: c.streaming === true, error: c.error ?? null } : null
    }, convId)
    if (!st) return { gone: true }
    if (!st.streaming) return st
    if (Date.now() - started > ms) return { timeout: true }
    await page.waitForTimeout(700)
  }
}

/** Наблюдаемое состояние беседы: точки отката, копии, id сессии. */
export const convState = (page, convId) =>
  page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return c
      ? {
          checkpointing: c.checkpointing === true,
          turns: c.turnMarks ?? [],
          sessionId: c.sessionId ?? null,
          streaming: c.streaming === true
        }
      : null
  }, convId)

/* ── Экран ──────────────────────────────────────────────────────────────── */

/** Текст видимых элементов: прошлые панели остаются в DOM скрытыми. */
export const text = (page, sel) =>
  page.evaluate(
    (s) =>
      [...document.querySelectorAll(s)]
        .filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
        .map((e) => e.textContent ?? '')
        .join('\n'),
    sel
  )

/**
 * Нажать кнопку по её тексту среди видимых.
 *
 * По умолчанию — у ПОСЛЕДНЕГО подходящего элемента: беседа обычно начинается с
 * приветствия, у которого тоже есть своя точка отката, а человека интересует
 * свежий ход.
 */
export const clickByText = (page, sel, needle, { first = false } = {}) =>
  page.evaluate(
    ([s, n, useFirst]) => {
      const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
      const all = [...document.querySelectorAll(s)]
        .filter(vis)
        .filter((e) => (e.textContent ?? '').includes(n))
      const b = useFirst ? all[0] : all[all.length - 1]
      b?.click()
      return !!b
    },
    [sel, needle, first]
  )

/** Открыть карточку отката у последнего хода и дождаться, пока она соберётся. */
export async function openRewind(page, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now()
  const found = await clickByText(page, '.zy-mf-changes-btn', 'Откатить файлы')
  if (!found) return { opened: false, ms: 0 }
  for (;;) {
    const card = await text(page, '.zy-rw')
    if (/Файлов:|Движок не назвал|not enabled|Идёт ход|эта точка/i.test(card)) {
      return { opened: true, ms: Date.now() - t0, card }
    }
    if (Date.now() - t0 > timeoutMs) return { opened: true, ms: Date.now() - t0, card, slow: true }
    await page.waitForTimeout(300)
  }
}

/**
 * Дождаться кнопки «Откатить» в открытой карточке.
 *
 * Без этого прогон падал таймаутом Playwright и молчал о причине — а причина
 * (карточка в отказе, движок занят, список пуст) как раз и есть то, что надо
 * знать.
 */
export async function waitForGo(page, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    const n = await page.evaluate(
      () =>
        [...document.querySelectorAll('.zy-rw-go')].filter((el) =>
          el.checkVisibility ? el.checkVisibility() : !!el.offsetParent
        ).length
    )
    if (n > 0) return true
    if (Date.now() - t0 > ms) return false
    await page.waitForTimeout(250)
  }
}

export const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${LIVE ? 'live' : 'fake'}-${name}.png`) })
}

/* ── Следы на диске ─────────────────────────────────────────────────────── */

export const backupsOf = (userData) => {
  try {
    return readdirSync(join(userData, 'rewind-backup'))
  } catch {
    return []
  }
}

export function backupContents(userData, dirName) {
  const dir = join(userData, 'rewind-backup', dirName)
  try {
    return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'))
  } catch {
    return []
  }
}

/** Сколько сессий движок насыпал в свою папку копий (для честного отчёта). */
export const fileHistoryCount = () => {
  const d = join(homedir(), '.claude', 'file-history')
  try {
    return existsSync(d) ? readdirSync(d).length : 0
  } catch {
    return 0
  }
}

export const cleanup = (dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка — не наша забота */
    }
  }
}
