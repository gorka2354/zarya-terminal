/**
 * «Что изменилось в проекте» — панель под ходом человека.
 *
 * Смысл прогона: панель обязана видеть ВСЁ, что произошло с файлами, а не
 * только то, о чём отчитался агент. Родной откат движка не трекает работу
 * оболочки, субагентов и человека — поэтому здесь файлы меняются в обход
 * агента (обычной записью на диск, как это делает `npm install` или сам
 * человек в терминале рядом), и панель всё равно должна их назвать.
 *
 * Проверяется три вещи, каждая из которых была бы враньём при ошибке:
 * 1) удалённый файл назван удалённым, а не «добавленным» (git помнит обе
 *    буквы состояния, и наивный разбор берёт не ту);
 * 2) опасное стоит выше: удаление первым, сборка последней — человек не
 *    досматривает список до конца;
 * 3) там, где git ответить не может (папка вне репозитория), панель говорит
 *    это словами, а не показывает пустой список — пустой список читается как
 *    «ничего не менялось».
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-changes-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-changesw-'))
const plain = mkdtempSync(join(tmpdir(), 'zarya-changesp-')) // папка БЕЗ git
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

// Репозиторий с историей: без коммита сравнивать не с чем и панель честно
// сказала бы «ничего не изменилось» — проверять было бы нечего.
const git = (...args) =>
  execFileSync('git', args, { cwd: work, stdio: 'pipe', encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'qa@zarya.local')
git('config', 'user.name', 'QA')
writeFileSync(join(work, 'keep.ts'), 'export const a = 1\n')
writeFileSync(join(work, 'gone.ts'), 'export const b = 2\n')
writeFileSync(join(work, 'edited.ts'), 'line one\nline two\nline three\n')
git('add', '-A')
git('commit', '-qm', 'base')

// Дальше — изменения В ОБХОД агента: ровно то, чего родной откат не видит.
rmSync(join(work, 'gone.ts'))
writeFileSync(join(work, 'edited.ts'), 'line one\nline two CHANGED\nline three\n')
mkdirSync(join(work, 'dist'), { recursive: true })
writeFileSync(join(work, 'dist', 'bundle.js'), 'console.log(1)\n')

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
    w.setSize(1180, 760)
    w.center()
  })
  await page.waitForTimeout(2600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  await page.waitForTimeout(600)

  console.log('\n[1] У хода человека появилась кнопка «что изменилось»')
  await page.evaluate(() => window.__zaryaAskAgent?.('посмотри проект', 'codex'))
  await page.waitForTimeout(1800)
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.zy-mf-changes-btn')].filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))[0]
    return b ? { text: b.textContent ?? '' } : null
  })
  ok('кнопка на экране', !!btn, btn)
  ok('подписана по-человечески', /что изменилось/i.test(btn?.text ?? ''), btn?.text)

  console.log('\n[2] Панель называет все изменения, включая сделанные мимо агента')
  await page.locator('.zy-mf-changes-btn:visible').first().click()
  await page.waitForTimeout(1200)
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-change')].filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)).map((el) => ({
      kind: el.querySelector('.zy-mf-change-kind')?.textContent ?? '',
      path: el.querySelector('.zy-mf-change-path')?.textContent ?? ''
    }))
  )
  ok('панель раскрылась и что-то показала', rows.length > 0, rows)
  // Агент не делал НИЧЕГО из этого: файлы менялись записью на диск. Панель
  // видит их потому, что смотрит на состояние дерева, а не на отчёт агента.
  ok('удалённый файл найден', rows.some((r) => /gone\.ts$/.test(r.path)), rows)
  ok('изменённый файл найден', rows.some((r) => /edited\.ts$/.test(r.path)), rows)
  // git схлопывает НОВЫЙ каталог в одну строку (`dist/`) и не перечисляет
  // файлы внутри: панель обязана показать это как папку, а не выдумывать файл.
  ok('новая папка вне git найдена', rows.some((r) => /^dist\/$/.test(r.path)), rows)
  ok(
    'папка названа папкой, а не файлом',
    /папка/i.test(rows.find((r) => /^dist\/$/.test(r.path))?.kind ?? ''),
    rows.find((r) => /^dist\/$/.test(r.path))
  )
  ok('нетронутый файл НЕ показан', !rows.some((r) => /keep\.ts$/.test(r.path)), rows)

  const gone = rows.find((r) => /gone\.ts$/.test(r.path))
  ok('удаление названо удалением', /удал/i.test(gone?.kind ?? ''), gone)
  ok('удаление стоит первым — оно дороже всего', /gone\.ts$/.test(rows[0]?.path ?? ''), rows[0])
  ok(
    'сборка ушла вниз списка',
    /^dist\/$/.test(rows[rows.length - 1]?.path ?? ''),
    rows[rows.length - 1]
  )
  // У папки нет диффа — значит нет и каретки, которая его обещает.
  const dirCaret = await page.evaluate(
    () =>
      [...document.querySelectorAll('.zy-mf-change')]
        .filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
        .find((e) => /^dist\/$/.test(e.querySelector('.zy-mf-change-path')?.textContent ?? ''))
        ?.querySelector('.zy-mf-change-caret') != null
  )
  ok('у папки нет каретки — раскрывать нечего', dirCaret === false)

  console.log('\n[3] Граница инструмента названа сразу, а не после промаха')
  const hint = await page.evaluate(
    () => [...document.querySelectorAll('.zy-mf-changes-hint')].filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))[0]?.textContent ?? ''
  )
  ok('сказано, с чем именно сравнивает git', /последним коммитом/i.test(hint), hint)
  ok('сказано про файлы вне репозитория и .gitignore', /gitignore/i.test(hint), hint)

  console.log('\n[4] Дифф раскрывается прямо в панели')
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.zy-mf-change')].filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)).find((e) =>
      /edited\.ts$/.test(e.querySelector('.zy-mf-change-path')?.textContent ?? '')
    )
    el?.querySelector('.zy-mf-change-head')?.click()
  })
  await page.waitForTimeout(900)
  const diff = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.zy-mf-diff-row')].filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
    return {
      add: rows.filter((r) => r.className.includes('--add')).map((r) => r.textContent ?? ''),
      del: rows.filter((r) => r.className.includes('--del')).map((r) => r.textContent ?? '')
    }
  })
  ok('показана новая строка', diff.add.some((s) => /CHANGED/.test(s)), diff.add)
  ok('показана убранная строка', diff.del.some((s) => /line two$/.test(s.trim())), diff.del)
  if (shots) await page.screenshot({ path: join(shots, 'changes-panel.png') })

  console.log('\n[5] Файл, который правил АГЕНТ, помечен — и отличим от чужой правки')
  // Фейк здесь пишет файл ПО-НАСТОЯЩЕМУ (fakeWrite в fakeAgentDriver): панель
  // читает диск, и прогон, где правка только объявлена в ленте, не проверял бы
  // ничего. Слово edit в запросе включает именно этот сценарий.
  // Автопилот — свойство беседы: без него фейк остановится на карточке
  // одобрения и до диска не дойдёт, а нам нужна настоящая запись файла.
  const convId = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(900)
  await page.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), convId)
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__zaryaFollowUp?.('tool edit: поправь файл'))
  await page.waitForTimeout(2400)
  await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const btns = [...document.querySelectorAll('.zy-mf-changes-btn')].filter(vis)
    btns[btns.length - 1]?.click()
  })
  await page.waitForTimeout(1500)
  const tagged = await page.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    return [...document.querySelectorAll('.zy-mf-change')].filter(vis).map((el) => ({
      path: el.querySelector('.zy-mf-change-path')?.textContent ?? '',
      agent: !!el.querySelector('.zy-mf-change-agent')
    }))
  })
  // Агент создал src/shared/fake.ts — но git схлопывает НОВУЮ папку в одну
  // строку `src/` и не перечисляет файлы внутри. Панель обязана пометить
  // именно её: иначе работа агента выглядела бы как чья-то чужая.
  const fake = tagged.find((r) => /^src\/$/.test(r.path))
  ok('запись агента появилась в списке', !!fake, tagged)
  ok('она помечена как правленная агентом', fake?.agent === true, fake)
  // В том же списке лежат файлы, которых агент не касался. Если пометка стоит
  // на всех подряд — она не несёт смысла и врёт про авторство.
  const human = tagged.find((r) => /edited\.ts$/.test(r.path))
  ok('чужая правка человека НЕ помечена агентом', human?.agent === false, human)
  if (shots) await page.screenshot({ path: join(shots, 'changes-agent-mark.png') })

  console.log('\n[6] Вне репозитория панель говорит это словами')
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), plain)
  await page.waitForTimeout(1600)
  await page.evaluate(() => window.__zaryaAskAgent?.('посмотри проект', 'codex'))
  await page.waitForTimeout(1800)
  await page.locator('.zy-mf-changes-btn:visible').first().click()
  await page.waitForTimeout(1200)
  const empty = await page.evaluate(
    () => [...document.querySelectorAll('.zy-mf-changes-empty')].filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))[0]?.textContent ?? ''
  )
  // Пустой список читался бы как «ничего не менялось» — то есть как знание,
  // которого у нас нет. Отказ обязан назвать причину.
  ok('сказано, что git тут нет', /нет git/i.test(empty), empty)
  // И честный отказ обязан указать ручной путь: правки агента видны в ленте
  // хода, просто не этой панелью. Иначе «нет git» читается как «ничего нет».
  ok('назван путь, где всё-таки видно правки', /ленте/i.test(empty), empty)
  if (shots) await page.screenshot({ path: join(shots, 'changes-nogit.png') })

  console.log(`\nПромежуточно: ${pass} ok, ${fail} fail`)
} finally {
  await app.close()
}

/*
 * [7] Самый неприятный случай — агент пишет ЗА ПРЕДЕЛЫ папки панели.
 *
 * В прогонах разведки настоящий Claude Code при cwd=w4 записал файл в чужой
 * проект на рабочем столе, и родной откат потом удалил его там же. Про такие
 * файлы git этой панели не скажет НИКОГДА: они вне репозитория. Промолчать —
 * значит оставить человека с уверенностью, что он видит всё изменённое.
 *
 * Путь фейку задаётся окружением, а оно фиксируется при запуске процесса, —
 * поэтому проверка идёт вторым запуском приложения, а не в первом.
 */
const outsideDir = mkdtempSync(join(tmpdir(), 'zarya-changes-out-'))
const outsideFile = join(outsideDir, 'stranger.ts')
const app2 = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    ZARYA_FAKE_OUTSIDE: outsideFile,
    NODE_ENV: 'production'
  }
})

try {
  console.log('\n[7] Про файл, записанный ВНЕ репозитория, панель говорит отдельно')
  const page2 = await app2.firstWindow()
  await page2.waitForLoadState('domcontentloaded')
  await app2.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1180, 760)
    w.center()
  })
  await page2.waitForTimeout(2600)
  await page2.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page2.waitForTimeout(1600)
  await page2.evaluate(() => window.__zaryaSetUi?.({ sidebarView: null }))
  const cid = await page2.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page2.waitForTimeout(900)
  await page2.evaluate((c) => window.__zaryaSetBypassFor?.(c, true), cid)
  await page2.waitForTimeout(400)
  await page2.evaluate(() => window.__zaryaFollowUp?.('tool edit: поправь файл'))
  await page2.waitForTimeout(2400)
  await page2.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const btns = [...document.querySelectorAll('.zy-mf-changes-btn')].filter(vis)
    btns[btns.length - 1]?.click()
  })
  await page2.waitForTimeout(1500)
  const outside = await page2.evaluate(() => {
    const vis = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent)
    const box = [...document.querySelectorAll('.zy-mf-changes-outside')].filter(vis)[0]
    return box
      ? {
          top: box.querySelector('.zy-mf-changes-outside-top')?.textContent ?? '',
          rows: [...box.querySelectorAll('.zy-mf-changes-outside-row')].map(
            (r) => r.textContent ?? ''
          )
        }
      : null
  })
  ok('блок про файлы вне репозитория на экране', !!outside, outside)
  ok('сказано, что это вне этого репозитория', /вне этого репозитория/i.test(outside?.top ?? ''), outside?.top)
  ok('назван сам файл', outside?.rows.some((r) => /stranger\.ts/.test(r)) === true, outside?.rows)
  if (shots) await page2.screenshot({ path: join(shots, 'changes-outside.png') })

  console.log(`\nИтог: ${pass} ok, ${fail} fail`)
} finally {
  await app2.close()
}
process.exit(fail ? 1 : 0)
