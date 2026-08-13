import { app } from 'electron'
import { mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import {
  CLI_NAME,
  cmdShim,
  normPath,
  pathAdd,
  pathHas,
  pathRemove,
  resolveCandidates,
  shShim
} from '@shared/cliShim'
import type { CliCommandState } from '@shared/types'

/**
 * Команда `zarya` в системе.
 *
 * inc-30 научил Зарю принимать папку из командной строки — а набрать `zarya .`
 * было негде: установщик кладёт exe и PATH не трогает. Регистрирует команду
 * САМО ПРИЛОЖЕНИЕ, а не установщик, и на то четыре довода (подробно —
 * `inc/inc-40-komanda-zarya.md`):
 *
 * 1. NSIS обрезает строки по `NSIS_MAX_STRLEN`. Пользовательский PATH владельца
 *    — 1184 знака; прочитать обрезок и записать его обратно значит стереть
 *    человеку половину PATH.
 * 2. Установщика нет у переносимой сборки, а команда там нужна так же.
 * 3. Приложение может ПРОВЕРИТЬ результат: перечитать реестр и самому разрешить
 *    имя по PATH и PATHEXT. Экран показывает не «мы записали», а «команда есть и
 *    ведёт вот сюда».
 * 4. Явное нажатие вместо тихой правки чужой системы при установке.
 */

/** Куда кладём шимы. Переменная — только для прогонов. */
function binDir(): string {
  const override = process.env.ZARYA_CLI_BIN_DIR
  if (override) return override
  /*
   * LOCALAPPDATA, а НЕ Roaming (где лежит userData): в доменной сети Roaming
   * синхронизируется между машинами, а внутри шима записан путь к exe ЭТОЙ
   * машины. Уехавший шим показывал бы «Заря не найдена» с путём к чужому диску.
   */
  const local = process.env.LOCALAPPDATA
  return local ? join(local, 'Zarya', 'bin') : join(app.getPath('userData'), 'bin')
}

/**
 * Ветка реестра с пользовательским окружением. Переменная — только для
 * прогонов: настоящий PATH человека им ломать нельзя, а проверять надо
 * настоящим чтением и настоящей записью.
 */
function regKey(): string {
  return process.env.ZARYA_CLI_REG_KEY || 'HKCU:\\Environment'
}

/** Прогон идёт против отдельной ветки — значит система не при чём. */
function isolated(): boolean {
  return !!process.env.ZARYA_CLI_REG_KEY
}

/**
 * Что именно должен запускать шим.
 *
 * У собранного приложения это сам exe. В разработке exe — это `electron.exe`, и
 * первым аргументом ему нужен наш главный скрипт; ровно эту форму и разбирает
 * `@shared/cliArgs` при `packaged: false`.
 *
 * Переносимая сборка распаковывается во временную папку, и `getPath('exe')`
 * указывает туда — путь живёт до конца сеанса. Настоящий файл называет сам
 * лаунчер (та же переменная, по которой `updateService` понимает, что обновиться
 * нельзя).
 */
function target(): { exe: string; prefix: string[] } {
  if (!app.isPackaged) {
    return { exe: process.execPath, prefix: [process.argv[1] ?? app.getAppPath()] }
  }
  return { exe: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'), prefix: [] }
}

const PS = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/**
 * Запуск PowerShell.
 *
 * `-EncodedCommand`, потому что так у нас нет ни кавычек, ни политики
 * выполнения: base64 не разбирается оболочкой, а на `-EncodedCommand`
 * `ExecutionPolicy` не распространяется — иначе машина с политикой `Restricted`
 * получала бы отказ на ровном месте.
 *
 * Полный путь к powershell.exe намеренно: мы чиним PATH, и опираться на PATH
 * при этом — последнее, что стоит делать.
 */
function ps(script: string, timeoutMs = 15000): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/**
 * Строка внутрь скрипта — через base64, чтобы ни кавычки, ни кириллица, ни
 * процент не мешали.
 *
 * Скобки снаружи ОБЯЗАТЕЛЬНЫ. В позиции аргумента (`-Value …`) PowerShell
 * разбирает выражения не как выражения: голое `[Type]::Method(…)` там
 * становится обычной строкой, и в реестр уехал бы кусок исходника вместо PATH.
 */
function lit(value: string): string {
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  return `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`
}

/**
 * Прочитать PATH из реестра — БЕЗ раскрытия переменных.
 *
 * `DoNotExpandEnvironmentNames` здесь не украшение: `%USERPROFILE%\bin` при
 * обычном чтении вернулся бы уже раскрытым, и запись обратно превратила бы
 * переменную в жёсткий путь. У человека, который переименует папку профиля или
 * унесёт настройки на другую машину, PATH после этого сломался бы — а виноватой
 * выглядела бы не Заря.
 */
async function readPaths(): Promise<{ user: string; machine: string } | null> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$user = ''
$machine = ''
$key = ${lit(regKey())}
if (Test-Path $key) {
  $k = Get-Item $key
  $v = $k.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -ne $v) { $user = [string]$v }
}
if (${isolated() ? '$false' : '$true'}) {
  $mk = Get-Item 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  if ($null -ne $mk) {
    $mv = $mk.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $mv) { $machine = [string]$mv }
  }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @{ user = $user; machine = $machine }
`
  try {
    const out = await ps(script)
    const parsed = JSON.parse(out.trim()) as { user?: string; machine?: string }
    return { user: parsed.user ?? '', machine: parsed.machine ?? '' }
  } catch {
    // Реестр недоступен — политика, урезанные права. Это ответ «не знаю», а не
    // повод показать «команды нет»: разница видна на экране.
    return null
  }
}

/**
 * Записать пользовательский PATH.
 *
 * `-Type ExpandString` обязателен. `[Environment]::SetEnvironmentVariable`
 * записал бы `REG_SZ`, и `%JAVA_HOME%\bin` в чужом PATH перестал бы
 * раскрываться — поломка, которую человек связал бы с чем угодно, кроме нас.
 *
 * `WM_SETTINGCHANGE` — чтобы новые терминалы увидели команду сразу: процессы
 * получают окружение от explorer.exe, а он перечитывает реестр только по этому
 * сообщению. Без рассылки пришлось бы перезаходить в систему.
 */
async function writeUserPath(value: string): Promise<boolean> {
  const script = `
$ErrorActionPreference = 'Stop'
$key = ${lit(regKey())}
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name 'Path' -Value ${lit(value)} -Type ExpandString
${
  isolated()
    ? ''
    : `try {
  Add-Type -Namespace ZaryaNative -Name Win -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  $res = [UIntPtr]::Zero
  [ZaryaNative.Win]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res) | Out-Null
} catch {}`
}
`
  try {
    await ps(script, 30000)
    return true
  } catch (e) {
    /*
     * Молча вернуть false — то самое молчание, против которого весь проект.
     * В интерфейс отказ приезжает сам: экран перечитывает систему и покажет,
     * что папки в PATH нет. А ПРИЧИНУ, кроме как здесь, взять неоткуда.
     */
    console.error('[cli] PATH не записан:', e instanceof Error ? e.message : e)
    return false
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Кто на самом деле откликнется на слово `zarya`.
 *
 * Единственный честный ответ на вопрос «установилось ли»: пункт в реестре может
 * стоять, файлы лежать, а выигрывать чужая программа с тем же именем из папки
 * левее. Кнопка «установлено» без этой проверки соврала бы — а вранью человек
 * верит.
 *
 * ПОТОЛОК ПО ВРЕМЕНИ: в PATH попадают сетевые папки, и обращение к отвалившейся
 * шаре висит десятками секунд. Не дождались — говорим «не знаю», а не «нет».
 */
async function resolveCli(pathValue: string): Promise<string | null | undefined> {
  const pathext = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  const list = resolveCandidates(CLI_NAME, pathValue, pathext)
  const deadline = Date.now() + 4000
  for (const cand of list) {
    if (Date.now() > deadline) return undefined
    if (!(await exists(cand))) continue
    /*
     * Имя берём С ДИСКА, а не из PATHEXT. Иначе на экране оказывается
     * `zarya.CMD` — потому что в PATHEXT расширения записаны прописными, — а
     * файл на диске называется `zarya.cmd`. Мелочь, но это ровно тот сорт
     * мелочи, из-за которой человек ищет на диске не тот файл.
     */
    try {
      return await realpath(cand)
    } catch {
      return cand
    }
  }
  return null
}

/** Содержимое обоих шимов для текущего расположения приложения. */
function shims(): Array<{ path: string; body: string; mode: number }> {
  const dir = binDir()
  const { exe, prefix } = target()
  return [
    { path: join(dir, `${CLI_NAME}.cmd`), body: cmdShim(exe, prefix, dir), mode: 0o755 },
    { path: join(dir, CLI_NAME), body: shShim(exe, prefix, dir), mode: 0o755 }
  ]
}

async function fileMatches(p: string, body: string): Promise<boolean> {
  try {
    return (await readFile(p, 'utf8')) === body
  } catch {
    return false
  }
}

/**
 * Состояние для экрана. Ничего не меняет.
 *
 * Порядок вопросов тот же, в каком они рушатся: поддерживаем ли мы эту систему →
 * лежат ли файлы → знает ли о папке реестр → что выигрывает на самом деле.
 */
export async function cliStatus(): Promise<CliCommandState> {
  const dir = binDir()
  const { exe } = target()
  if (process.platform !== 'win32') {
    return { supported: false, dir, exe, files: 'none', onPath: false, resolved: null, ours: false }
  }

  const wanted = shims()
  const present = await Promise.all(wanted.map((s) => exists(s.path)))
  const fresh = await Promise.all(wanted.map((s) => fileMatches(s.path, s.body)))
  const files = fresh.every(Boolean) ? 'ok' : present.some(Boolean) ? 'stale' : 'none'

  const paths = await readPaths()
  if (!paths) {
    // Реестр не прочитался. «Не знаю» — это отдельное состояние, и на экране
    // оно должно выглядеть не так, как «не установлено».
    return { supported: true, dir, exe, files, onPath: false, resolved: undefined, ours: false }
  }

  const onPath = pathHas(paths.user, dir)
  const combined = [paths.machine, paths.user].filter(Boolean).join(';')
  const resolved = await resolveCli(combined)
  const ours = !!resolved && normPath(resolved).startsWith(normPath(dir) + '\\')
  return { supported: true, dir, exe, files, onPath, resolved, ours }
}

/**
 * Поставить команду. Файлы, потом реестр — в таком порядке, чтобы пункт PATH
 * никогда не указывал на пустоту.
 */
export async function cliInstall(): Promise<CliCommandState> {
  if (process.platform !== 'win32') return cliStatus()
  const dir = binDir()
  await mkdir(dir, { recursive: true })
  for (const s of shims()) await writeFile(s.path, s.body, { encoding: 'utf8', mode: s.mode })

  const paths = await readPaths()
  if (paths) {
    const next = pathAdd(paths.user, dir)
    if (next !== null) await writeUserPath(next)
  }
  return cliStatus()
}

/**
 * Убрать команду: сначала из PATH, потом файлы — обратный порядок установки,
 * чтобы в промежутке не осталось пункта, ведущего в никуда.
 *
 * Папка удаляется, только если она пуста: человек мог положить туда своё, и
 * снятие нашей команды — не повод это стирать.
 */
export async function cliRemove(): Promise<CliCommandState> {
  if (process.platform !== 'win32') return cliStatus()
  const dir = binDir()
  const paths = await readPaths()
  if (paths) {
    const next = pathRemove(paths.user, dir)
    if (next !== null) await writeUserPath(next)
  }
  for (const s of shims()) await rm(s.path, { force: true })
  try {
    await rmdir(dir)
  } catch {
    // Не пуста — оставляем как есть.
  }
  return cliStatus()
}

/**
 * Освежить шимы при запуске.
 *
 * Приложение обновилось или переехало — путь внутри шима устарел, и команда
 * начала бы отвечать «Заря не найдена». Папка в PATH при этом постоянная,
 * значит трогать реестр не нужно: правится только содержимое файла.
 *
 * САМИ ШИМЫ НЕ ЗАВОДИМ. Их нет — значит человек команду не ставил, и создавать
 * её без спроса Заря не будет.
 */
export async function cliRefresh(): Promise<void> {
  if (process.platform !== 'win32') return
  for (const s of shims()) {
    if (!(await exists(s.path))) continue
    if (await fileMatches(s.path, s.body)) continue
    try {
      await writeFile(s.path, s.body, { encoding: 'utf8', mode: s.mode })
    } catch {
      // Файл занят или прав нет — экран настроек покажет расхождение.
    }
  }
}
