/**
 * Команда `zarya` в системе: полный круг установки и снятия.
 *
 *   node scripts/cli-command-test.mjs
 *
 * Прогон правит НЕ настоящий PATH человека, а отдельную ветку реестра
 * (`HKCU:\Software\Zarya\QAEnv`) — её же читает и приложение, когда задана
 * `ZARYA_CLI_REG_KEY`. Чтение и запись при этом настоящие: подделывать реестр
 * бессмысленно, потому что именно в нём и живут все опасные тонкости — тип
 * значения, нераскрытые проценты, длинная строка.
 *
 * Проверяем две вещи, которые нельзя проверить юнитами:
 *   1. приложение доходит до реестра и обратно, не портя чужой PATH;
 *   2. сгенерированный `zarya.cmd` действительно передаёт аргументы дальше и
 *      честно ругается, когда Зари по записанному пути больше нет.
 */
import { _electron as electron } from 'playwright'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return !!cond
}
const note = (...a) => console.log('   ·', ...a)

if (process.platform !== 'win32') {
  console.log('ПРОПУЩЕНО: команда `zarya` пока только для Windows')
  process.exit(2)
}

const PS = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const ps = (script) =>
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  }).trim()

/** Ветка-песочница: настоящий Environment пользователя прогон не трогает. */
const КЛЮЧ = 'HKCU:\\Software\\Zarya\\QAEnv'

/**
 * Образец чужого PATH. Взят с машины владельца по форме: пустой пункт
 * посередине, папка с пробелом, нераскрытая переменная. Ровно это и ломают
 * наивные правки PATH.
 */
const ИСХОДНЫЙ = 'C:\\Windows\\System32;C:\\Windows;;%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd'

const ud = mkdtempSync(join(tmpdir(), 'zarya-cli-'))
const bin = join(mkdtempSync(join(tmpdir(), 'zarya-clibin-')), 'bin')
writeFileSync(
  join(ud, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

const убратьКлюч = () => {
  try {
    ps(`if (Test-Path '${КЛЮЧ}') { Remove-Item -Path '${КЛЮЧ}' -Recurse -Force }`)
  } catch {
    /* песочница и так временная */
  }
}

убратьКлюч()
ps(
  `New-Item -Path '${КЛЮЧ}' -Force | Out-Null; ` +
    `Set-ItemProperty -Path '${КЛЮЧ}' -Name 'Path' -Value '${ИСХОДНЫЙ}' -Type ExpandString`
)

const прочитать = () => {
  const raw = ps(
    `$k = Get-Item '${КЛЮЧ}'; ` +
      `$v = $k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); ` +
      `$t = $k.GetValueKind('Path'); "$t|$v"`
  )
  const i = raw.indexOf('|')
  return { kind: raw.slice(0, i), value: raw.slice(i + 1) }
}

/** Настоящее содержимое шима — понадобится в седьмом круге, уже без приложения. */
let СОДЕРЖИМОЕ = null

/** Что убрать в самом конце: пока приложение живо, часть папок оно держит. */
const временные = [ud]

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud,
    ZARYA_CLI_REG_KEY: КЛЮЧ,
    ZARYA_CLI_BIN_DIR: bin,
    // Замок единственного экземпляра: без него набранная в терминале команда
    // подняла бы ВТОРУЮ Зарю вместо того, чтобы отдать папку этой.
    ZARYA_SINGLE_INSTANCE: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

/** Пути сравниваем без учёта регистра и вида разделителя: Windows. */
const norm = (p) =>
  String(p ?? '')
    .split('\\')
    .join('/')
    .toLowerCase()
const открытыеПапки = (page) =>
  page.evaluate(() => (window.__zaryaDumpSessions?.()?.sessions ?? []).map((x) => x.cwd))

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  const вызов = (имя) => page.evaluate((m) => window.zarya.app[m](), имя)

  console.log('\n[1] До установки — «не установлена», и ничего не тронуто')
  const s0 = await вызов('cliStatus')
  note('состояние:', JSON.stringify({ files: s0.files, onPath: s0.onPath, ours: s0.ours }))
  ok('файлов нет', s0.files === 'none', s0.files)
  ok('в PATH нас нет', s0.onPath === false)
  ok('система поддерживается', s0.supported === true)
  ok('чужой PATH не тронут', прочитать().value === ИСХОДНЫЙ, прочитать().value)

  console.log('\n[2] Установка')
  const s1 = await вызов('cliInstall')
  const reg1 = прочитать()
  note('PATH после установки:', reg1.value)
  ok('оба файла на месте', s1.files === 'ok', s1.files)
  ok('zarya.cmd создан', existsSync(join(bin, 'zarya.cmd')))
  ok('zarya (sh) создан — без него git-bash команды не увидит', existsSync(join(bin, 'zarya')))
  ok('папка попала в PATH', s1.onPath === true)
  ok('на имя откликается НАШ файл', s1.ours === true, s1.resolved)
  ok('это именно zarya.cmd', /zarya\.cmd$/i.test(s1.resolved || ''), s1.resolved)
  СОДЕРЖИМОЕ = existsSync(join(bin, 'zarya.cmd'))
    ? readFileSync(join(bin, 'zarya.cmd'), 'utf8')
    : null

  console.log('\n[3] Чужой PATH пережил правку без единой потери')
  ok('тип значения остался REG_EXPAND_SZ', reg1.kind === 'ExpandString', reg1.kind)
  // Самая дорогая ошибка в этом инкременте: прочитать PATH с раскрытием
  // переменных и записать обратно уже раскрытым. Человек этого не заметит,
  // пока не переименует папку профиля.
  ok('%USERPROFILE% остался переменной', reg1.value.includes('%USERPROFILE%\\bin'), reg1.value)
  ok('пустой пункт посередине на месте', reg1.value.includes('C:\\Windows;;'), reg1.value)
  ok('дописано в КОНЕЦ', reg1.value === `${ИСХОДНЫЙ};${bin}`, reg1.value)

  console.log('\n[4] Набранное в терминале имя доезжает до открытой Зари')
  /*
   * Главное обещание инкремента, и проверяется оно целиком: имя команды ищет
   * настоящий cmd.exe по настоящему PATH, находит наш шим, шим запускает Зарю,
   * та видит, что одна уже работает, и отдаёт ей папку.
   *
   * PATH ребёнку даём ТОТ, что записан в песочницу реестра, — то есть ровно
   * тот, который получил бы новый терминал, будь эта ветка настоящей. Не
   * подделан здесь только один шаг: рассылка WM_SETTINGCHANGE, до которой
   * дотянуться из прогона нечем.
   */
  const проект = mkdtempSync(join(tmpdir(), 'zarya-cli-proj-'))
  const былоДо = (await открытыеПапки(page)).length
  const дочерний = spawnSync('cmd.exe', ['/c', 'zarya', проект], {
    env: {
      ...process.env,
      Path: прочитать().value.replace(/%USERPROFILE%/gi, process.env.USERPROFILE || ''),
      PATH: прочитать().value.replace(/%USERPROFILE%/gi, process.env.USERPROFILE || ''),
      ZARYA_USER_DATA: ud,
      ZARYA_SINGLE_INSTANCE: '1',
      ZARYA_NO_UPDATE_CHECK: '1',
      ZARYA_NO_ONBOARDING: '1',
      NODE_ENV: 'production'
    },
    timeout: 60_000,
    encoding: 'utf8'
  })
  ok('cmd.exe нашёл команду по имени', дочерний.status === 0, {
    status: дочерний.status,
    // Без этого поля пустой отказ выглядит как таймаут: `status: null` бывает и
    // тогда, когда до запуска дело не дошло вовсе.
    error: String(дочерний.error?.message ?? ''),
    out: String(дочерний.stdout ?? '').slice(0, 200),
    err: String(дочерний.stderr ?? '').slice(0, 200)
  })
  await page.waitForTimeout(6000)
  const папки = await открытыеПапки(page)
  ok(
    'папка открылась в УЖЕ РАБОТАЮЩЕЙ Заре',
    папки.some((c) => norm(c) === norm(проект)),
    { хотели: проект, есть: папки }
  )
  ok('это новая панель, а не подмена прежней', папки.length > былоДо, {
    было: былоДо,
    стало: папки.length
  })
  // Папку НЕ сносим здесь: она открыта панелью как рабочий каталог, и Windows
  // такую не отдаёт. Уборка — в конце, когда приложение уже закрыто.
  временные.push(проект)

  console.log('\n[5] Повторное нажатие не плодит второй пункт')
  const s2 = await вызов('cliInstall')
  ok('PATH не изменился', прочитать().value === reg1.value, прочитать().value)
  ok('состояние прежнее', s2.ours === true && s2.onPath === true)

  console.log('\n[6] Снятие возвращает ровно исходный PATH')
  const s3 = await вызов('cliRemove')
  const reg3 = прочитать()
  note('PATH после снятия:', reg3.value)
  ok('строка вернулась байт в байт', reg3.value === ИСХОДНЫЙ, reg3.value)
  ok('тип значения не испорчен', reg3.kind === 'ExpandString', reg3.kind)
  ok('файлы убраны', s3.files === 'none', s3.files)
  ok('папка удалена — Заря не оставляет мусор', !existsSync(bin))
  ok('команда больше не откликается', s3.ours === false && !s3.resolved, s3.resolved)
} finally {
  await app.close()
}

/*
 * Второй круг — без приложения. Шим это обычный batch-файл, и всё, что он
 * делает, делает cmd.exe: подстановку аргументов, кавычки, ветку «Зари больше
 * нет». Приложение для этого запускать незачем, а вот настоящий cmd.exe —
 * обязательно: в его правилах и живут все ошибки такого рода.
 */
console.log('\n[7] Сгенерированный zarya.cmd — на настоящем cmd.exe')
if (!СОДЕРЖИМОЕ) {
  ok('шим удалось прочитать после установки', false, 'файла не было')
} else {
  const песочница = mkdtempSync(join(tmpdir(), 'zarya-shim-'))
  /*
   * Берём НАСТОЯЩИЙ файл, который приложение только что записало, и подменяем в
   * нём одну строку — путь к Заре — на батник, печатающий свои аргументы.
   * Логика подстановки, кавычек и ветки «Зари больше нет» при этом остаётся
   * ровно той, что уедет к человеку; проверяет её настоящий cmd.exe, в чьих
   * правилах все ошибки такого рода и живут.
   */
  const фейк = join(песочница, 'FakeZarya.bat')
  writeFileSync(фейк, '@echo off\r\necho ARGS:[%*]\r\n')
  const шимПуть = join(песочница, 'zarya.cmd')
  const подменён = СОДЕРЖИМОЕ.replace(/set "ZARYA_EXE=.*"/, `set "ZARYA_EXE=${фейк}"`)
  ok('строка с путём к Заре в шиме нашлась', подменён !== СОДЕРЖИМОЕ)
  writeFileSync(шимПуть, подменён)

  const запуск = (args) =>
    execFileSync('cmd.exe', ['/c', шимПуть, ...args], { encoding: 'utf8' }).trim()

  const r1 = запуск(['.'])
  // В разработке перед папкой идёт ещё путь к главному скрипту — важно, что
  // наш аргумент доезжает ПОСЛЕДНИМ и целым.
  ok('точка доезжает до приложения', /ARGS:\[.*\.\]$/.test(r1), r1)
  /*
   * Путь ЛАТИНИЦЕЙ намеренно: batch печатает в кодовой странице консоли, и
   * кириллица в выводе превратится в мусор — но проверяем-то мы не вывод, а
   * то, что пробел не разорвал аргумент надвое.
   */
  const r2 = запуск(['C:\\My Projects\\zaryadka'])
  ok('путь с пробелом не разрывается', r2.includes('"C:\\My Projects\\zaryadka"'), r2)

  // Зарю удалили, команду снять забыли: человек должен получить имя папки,
  // а не «не является внутренней или внешней командой».
  rmSync(фейк)
  let вывод = ''
  let код = 0
  try {
    вывод = запуск([])
  } catch (e) {
    вывод = String(e.stdout || '')
    код = e.status
  }
  ok('код возврата не нулевой', код !== 0, код)
  ok('назван путь, которого нет', вывод.includes('FakeZarya.bat'), вывод)
  ok('названа папка для снятия из PATH', вывод.includes(песочница), вывод)
  rmSync(песочница, { recursive: true, force: true })
}

убратьКлюч()
for (const d of временные) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* временная папка */
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)
