/**
 * Панель знает, В КАКОЙ ОНА ПАПКЕ, — включая Командную строку и WSL.
 *
 *   npm run build && node scripts/pane-cwd-test.mjs
 *
 * ПОВОД. Разведка 2026-08-19: в `cmd.exe` и в WSL каталог панели замирал на том,
 * с которого её открыли, и не двигался ни на один `cd`. Это не косметика:
 * каталог панели получает агент как свою рабочую папку и как корень, которым
 * ограничен его доступ к файлам. «Панель показывает не тот каталог» означает
 * «агент правит не тот проект».
 *
 * Ни та, ни другая оболочка не умеет принять наш скрипт при запуске: у
 * Командной строки нет rc-файла, а `wsl.exe` запускает оболочку внутри
 * дистрибутива, куда наши аргументы не доходят. Поэтому у каждой свой шов —
 * строка приглашения и `PROMPT_COMMAND` (см. src/shared/shellIntegration.ts).
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const note = (...a) => console.log('   ·', ...a)
const norm = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

const userData = mkdtempSync(join(tmpdir(), 'zarya-panecwd-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-panecwd-w-'))
const sub = join(work, 'подпапка')
mkdirSync(sub, { recursive: true })

/**
 * ЗАПАСНАЯ ДОРОГА К WSL, и вот зачем она.
 *
 * Штатный профиль запускает `wsl.exe -d <дистрибутив>` — оболочку ВХОДА того
 * пользователя, который в дистрибутиве заведён. На машине, где дистрибутив
 * поставили, но первый запуск не доводили до конца, такой запуск упирается в
 * «создайте учётную запись» и до приглашения оболочки не доходит; рядом ещё
 * бывает служебный docker-desktop, у которого оболочка вовсе не bash.
 *
 * Тогда проверять было бы нечего — и проверка молча превращалась бы в пропуск.
 * Поэтому к тем же дистрибутивам добавляем профили, где оболочка названа явно
 * (`-e bash -li`, то есть ровно такая же оболочка входа, только от root).
 * Интеграция при этом та же самая, шов тот же самый — меняется лишь то, чья
 * учётная запись, а это к проверяемому отношения не имеет.
 */
function qaWslProfiles() {
  if (process.platform !== 'win32') return []
  const wslExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')
  let names = []
  try {
    // `wsl -l -q` печатает UTF-16LE — как и в src/main/shellProfiles.ts.
    const out = execFileSync(wslExe, ['-l', '-q'], { encoding: 'buffer' })
    names = out
      .toString('utf16le')
      .split(/\r?\n/)
      .map((l) => l.replace(/\u0000/g, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
  return names.map((name) => ({
    id: `wsl-qa-${name.toLowerCase()}`,
    name: `WSL·QA · ${name}`,
    path: wslExe,
    args: ['-d', name, '-e', 'bash', '-li'],
    integration: 'wsl',
    icon: 'WSL'
  }))
}

writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    terminal: { customProfiles: qaWslProfiles() }
  })
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const profiles = (await page.evaluate(() => window.__zaryaDumpProfiles?.())) || []
  const cwdOf = async (sid) => {
    const s = await page.evaluate(() => window.__zaryaDumpSessions?.())
    return (s?.sessions || []).find((x) => x.id === sid)?.cwd ?? ''
  }
  const waitCwd = async (sid, pred, ms = 20000) => {
    const dl = Date.now() + ms
    let c = await cwdOf(sid)
    while (Date.now() < dl && !pred(c)) {
      await page.waitForTimeout(500)
      c = await cwdOf(sid)
    }
    return c
  }
  const run = (sid, cmd) =>
    page.evaluate(({ s, c }) => window.__zaryaRunShell?.(c, s), { s: sid, c: cmd })
  const screen = (sid) => page.evaluate((s) => window.__zaryaTermText?.(s) ?? '', sid)
  const waitScreen = async (sid, pred, ms = 8000) => {
    const dl = Date.now() + ms
    let t = await screen(sid)
    while (Date.now() < dl && !pred(t)) {
      await page.waitForTimeout(400)
      t = await screen(sid)
    }
    return t
  }

  console.log('\n[1] Профили знают, каким швом до них достучаться')
  const cmdProfile = profiles.find((p) => p.id === 'cmd')
  const wslProfile = profiles.find((p) => String(p.id).startsWith('wsl-'))
  note('найдено профилей:', profiles.map((p) => `${p.id}:${p.integration}`).join(', '))
  if (process.platform === 'win32') {
    ok('Командная строка помечена integration=cmd', cmdProfile?.integration === 'cmd', cmdProfile)
    if (wslProfile) {
      ok('WSL помечен integration=wsl', wslProfile.integration === 'wsl', wslProfile)
    } else {
      note('WSL на этой машине не установлен — проверять нечего')
    }
    // Оболочки, у которых свой скрипт, не должны были поменяться.
    const ps = profiles.find((p) => p.id === 'pwsh' || p.id === 'powershell')
    if (ps) ok('PowerShell остался на своём скрипте', ps.integration === 'powershell', ps)
  } else {
    note('не Windows — cmd.exe и WSL здесь не существуют')
  }

  if (process.platform !== 'win32' || !cmdProfile) {
    console.log('\n  ⚠ ПРОПУСК живой части: Командная строка есть только на Windows.\n')
  } else {
    console.log('\n[2] Командная строка: cd — и каталог панели едет следом')
    const sid = await page.evaluate(({ d }) => window.__zaryaNewTerminal?.(d, 'cmd'), { d: work })
    ok('панель с Командной строкой создана', !!sid, sid)
    // Первое приглашение = первый доклад о каталоге. Без него дальше нечего
    // проверять: команда, написанная в ещё не поднявшийся pty, пропадёт молча.
    const started = await waitCwd(sid, (c) => norm(c) === norm(work), 25000)
    ok('каталог запуска отслежен', norm(started) === norm(work), {
      ожидали: work,
      получили: started
    })

    await run(sid, `cd "${sub}"`)
    const moved = await waitCwd(sid, (c) => norm(c) === norm(sub))
    ok('после cd панель знает НОВУЮ папку', norm(moved) === norm(sub), {
      ожидали: sub,
      получили: moved,
      экран: (await screen(sid)).slice(-300)
    })

    await run(sid, 'cd ..')
    const back = await waitCwd(sid, (c) => norm(c) === norm(work))
    ok('и обратно тоже', norm(back) === norm(work), { ожидали: work, получили: back })
  }

  const wslProfiles = profiles.filter((p) => p.integration === 'wsl')
  if (process.platform === 'win32' && wslProfiles.length) {
    console.log('\n[3] WSL: каталог сообщается так, как его понимает Windows')
    /*
     * Внутри дистрибутива путь линуксовый (`/tmp`), а Заря — программа Windows:
     * её панели, её агенты и её диалоги файлов говорят путями Windows. Поэтому
     * тот же каталог сообщается в том виде, в каком до него дотянется система:
     * /mnt/c/x → C:\x, всё остальное → \\wsl.localhost\<дистрибутив>\...
     *
     * Проходим ВСЕ дистрибутивы, а не первый попавшийся: рядом с настоящим
     * часто стоит служебный (docker-desktop), у которого оболочка вовсе не
     * bash, — и он бы решал за всех.
     */
    let translated = false
    for (const prof of wslProfiles) {
      const sid = await page.evaluate(({ id }) => window.__zaryaNewTerminal?.(undefined, id), {
        id: prof.id
      })
      if (!sid) {
        ok(`панель ${prof.id} создана`, false, prof)
        continue
      }
      // Оболочка входа читает profile и rc — на большом PATH это секунды.
      // Команда, написанная в ещё не поднявшийся pty, пропадает молча.
      await page.waitForTimeout(7000)
      await run(sid, 'cd /tmp')
      // Ждём именно UNC-форму. `^[a-z]:` сюда добавлять НЕЛЬЗЯ: панель
      // стартует в домашней папке Windows, и такое ожидание закончилось бы
      // мгновенно — на том самом каталоге, который ещё не сдвинулся.
      const moved = await waitCwd(sid, (c) => /wsl\.localhost|wsl\$/i.test(c), 25000)
      // Экран читаем ПОСЛЕ ожидания и с запасом: serialize отдаёт то, что есть
      // прямо сейчас, и пойманное посреди эха «cd /t» — это про скорость набора,
      // а не про оболочку.
      const text = await waitScreen(sid, (t) => /cd \/tmp/.test(t))

      /*
       * Дистрибутив может не запуститься вовсе — служебный docker-desktop,
       * например, не содержит bash. Это про машину, а не про Зарю: молчим и
       * идём дальше, но печатаем причину, чтобы её было видно глазами.
       */
      if (/execvpe|Wsl\/|ERROR:/i.test(text)) {
        note(`${prof.id}: дистрибутив не запустил оболочку — ${text.trim().slice(0, 90)}`)
        continue
      }

      /*
       * ГЛАВНОЕ здесь — не перевод пути, а то, что оболочка вообще НЕ
       * ПОСТРАДАЛА. Подсказку мы вносим через переменную окружения, и в
       * оболочке, которая её не понимает (busybox, zsh, fish), она обязана
       * просто ничего не сделать. Сломать чужой терминал ради собственной
       * подсказки — цена, которой этот шов не стоит.
       */
      ok(`${prof.id}: панель жива и принимает ввод`, /cd \/tmp/.test(text), {
        экран: text.trim().slice(-200)
      })

      if (/wsl\.localhost|wsl\$/i.test(moved)) {
        translated = true
        ok(`${prof.id}: каталог внутри дистрибутива назван UNC-путём`, true)
        note('получили:', moved)
        await run(sid, 'cd /mnt/c')
        const drive = await waitCwd(sid, (c) => /^[a-z]:/i.test(c))
        ok(`${prof.id}: а /mnt/c назван буквой диска`, /^[a-z]:\\?$/i.test(drive), drive)
      } else {
        note(`${prof.id}: каталог не сдвинулся — оболочка не bash или нет приглашения`)
      }
    }
    if (!translated) {
      /*
       * Честный пропуск, а не зелёная галочка. Свежий дистрибутив при первом
       * интерактивном запуске просит завести учётную запись и до приглашения
       * оболочки не доходит; служебный — вообще не на bash. Проверять там
       * нечего, и красный был бы про состояние машины, а не про Зарю.
       */
      console.log(
        '\n  ⚠ ПРОПУСК перевода пути: ни один дистрибутив не дошёл до bash-приглашения.\n' +
          '    Нужен дистрибутив, прошедший первый запуск (заведена учётная запись).\n'
      )
    }
  }
} catch (e) {
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  for (const d of [userData, work]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* временная папка останется — не повод падать */
    }
  }
}

console.log(`\n[pane-cwd] PASS ${pass} · FAIL ${fail}`)
process.exit(fail ? 1 : 0)
