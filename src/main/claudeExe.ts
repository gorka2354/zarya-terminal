import { execFile } from 'child_process'
import { existsSync } from 'fs'

/**
 * Which `claude` binary Zarya runs.
 *
 * The model catalog, the effort levels and every new capability come from the
 * CLI binary itself — the SDK is only a client. Zarya ships a bundled binary
 * (pinned by the @anthropic-ai/claude-agent-sdk version), so on its own the app
 * would keep showing whatever models existed the day it was built: a brand-new
 * model (e.g. Opus 5) stays invisible until we cut a release.
 *
 * The user's own `claude` CLI, meanwhile, updates itself. So we prefer THAT one
 * whenever it is genuinely newer — new models then appear on their own, with no
 * Zarya rebuild. Guard rails: never downgrade below the bundled binary, and
 * never cross a MAJOR version (a different major is a different protocol track,
 * where an older SDK client may not be understood).
 *
 * Everything here is a pure function of its inputs except probeVersion(), so
 * the policy is unit-testable without Electron or a real binary.
 */

/** Parse a `claude --version` banner ("2.1.220 (Claude Code)") into [2,1,220]. */
export function parseCliVersion(out: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Semver-ish compare of numeric tuples: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The platform-specific SDK package that carries the bundled native binary. */
export function bundledPkgName(platform: string, arch: string): string {
  if (platform === 'win32') return 'claude-agent-sdk-win32-x64'
  if (platform === 'darwin') return `claude-agent-sdk-darwin-${arch}`
  return `claude-agent-sdk-linux-${arch}`
}

/** Executable file name for the platform. */
export function claudeExeName(platform: string): string {
  return platform === 'win32' ? 'claude.exe' : 'claude'
}

/**
 * Absolute paths where a user-installed `claude` may live, best-known first.
 * npm-global and the native installer are the two supported install routes;
 * the rest are common package-manager prefixes. Pure — takes env/home so tests
 * can drive any platform.
 */
export function systemClaudeCandidates(
  platform: string,
  env: Record<string, string | undefined>,
  home: string
): string[] {
  const sep = platform === 'win32' ? '\\' : '/'
  const j = (...parts: string[]): string => parts.join(sep)
  if (platform === 'win32') {
    const appData = env.APPDATA
    const localAppData = env.LOCALAPPDATA
    const out: string[] = []
    if (appData) {
      out.push(
        j(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      )
    }
    out.push(j(home, '.local', 'bin', 'claude.exe'))
    out.push(j(home, '.claude', 'local', 'claude.exe'))
    if (localAppData) out.push(j(localAppData, 'Programs', 'claude', 'claude.exe'))
    return out
  }
  return [
    j(home, '.local', 'bin', 'claude'),
    j(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude'
  ]
}

export interface ExeCandidate {
  path: string
  /** undefined when `--version` failed, hung, or was unparseable. */
  version?: number[]
}

export type ExeReason =
  | 'env'
  /** User's own CLI is newer on the same major — models stay fresh by itself. */
  | 'system-newer'
  /** Shipped binary wins (system absent, older, unprobeable, or a different major). */
  | 'bundled'
  /** Nothing resolvable — let the SDK auto-resolve. */
  | 'sdk-default'

export interface ExePick {
  path?: string
  reason: ExeReason
}

/**
 * Decide which binary to hand the SDK. Ordering: explicit env override, then a
 * strictly-newer same-major system CLI, then the bundled binary, then nothing
 * (SDK default). A system binary we could not version-probe is never chosen —
 * unknown beats the known-good bundled one only when it is provably newer.
 */
export function pickClaudeExe(o: {
  envOverride?: string
  bundled?: ExeCandidate
  system?: ExeCandidate
}): ExePick {
  const env = o.envOverride?.trim()
  if (env) return { path: env, reason: 'env' }

  const { bundled, system } = o
  if (
    system?.version &&
    bundled?.version &&
    system.version[0] === bundled.version[0] &&
    compareVersions(system.version, bundled.version) > 0
  ) {
    return { path: system.path, reason: 'system-newer' }
  }
  if (bundled) return { path: bundled.path, reason: 'bundled' }
  return { reason: 'sdk-default' }
}

/**
 * Run `<exe> --version` and parse it. Resolves undefined on any failure so a
 * missing/hung/foreign binary can never block startup or throw into the caller.
 */
export function probeVersion(exe: string, timeoutMs = 5000): Promise<number[] | undefined> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v?: number[]): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const child = execFile(exe, ['--version'], { timeout: timeoutMs }, (err, stdout) => {
        if (err && !stdout) return finish(undefined)
        finish(parseCliVersion(String(stdout)))
      })
      child.on('error', () => finish(undefined))
    } catch {
      finish(undefined)
    }
  })
}

/**
 * Понимает ли этот бинарник наш дополнительный флаг.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Часть возможностей движка включается флагом командной
 * строки, которого нет в типизированном контракте SDK (`--replay-user-messages`
 * для отката кода). SDK передаёт такие флаги как есть — сырой строкой в конец
 * командной строки, — а CLI на неизвестный КОРНЕВОЙ флаг падает сразу:
 * `error: unknown option`, код выхода 1, ход не начинается вовсе.
 *
 * Опасность не в потере функции, а в её цене: Заря перевыбирает бинарник каждые
 * полчаса без перезапуска, и человек с самообновившимся `claude` получил бы не
 * «откат недоступен», а «агент не отвечает» — на каждый ход, без единой
 * подсказки о причине. Поэтому флаг не ставится вслепую: сначала спрашиваем сам
 * бинарник.
 *
 * ПОЧЕМУ ИМЕННО `mcp` БЕЗ ПОДКОМАНДЫ. Проверено на 2.1.227:
 * - `--version` и `--help` разбирают флаги НЕ полностью: неизвестный флаг там
 *   проходит молча (exit 0), то есть проба всегда отвечала бы «поддерживается»;
 * - `mcp list` отвечает правильно, но 10 секунд: он реально опрашивает
 *   MCP-серверы человека, то есть запускает чужие процессы;
 * - `mcp` без подкоманды печатает свою справку и выходит за ~0.5 с, ничего не
 *   запуская, но флаги разбирает по-настоящему.
 */
export function flagUnsupported(stderr: string, flag: string): boolean {
  const s = String(stderr || '')
  if (!/unknown option/i.test(s)) return false
  // Имя флага в сообщении обязательно: `unknown option` про ЧУЖОЙ аргумент
  // (например, опечатку в подкоманде) не должен выключать нашу возможность.
  return s.includes(flag)
}

/**
 * Спросить бинарник про флаг. `true` — флаг понят.
 *
 * Неудачная проба (таймаут, бинарник не запустился) — это НЕ «поддерживается»:
 * молчание трактуем в пользу безопасности, потому что цена ошибки здесь —
 * неработающий агент, а цена лишней осторожности — отсутствие одной кнопки.
 */
export function probeFlag(exe: string, flag: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: boolean): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const child = execFile(
        exe,
        [flag, 'mcp'],
        { timeout: timeoutMs, windowsHide: true },
        (_err, _stdout, stderr) => finish(!flagUnsupported(String(stderr ?? ''), flag))
      )
      child.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

/** Ответ пробы на один бинарник: что решили и когда. */
interface FlagCacheEntry {
  ok: boolean
  at: number
}

const flagCache = new Map<string, FlagCacheEntry>()

/**
 * Проба с памятью: один вопрос на бинарник, а не на каждый ход.
 *
 * Срок жизни ответа совпадает со сроком, через который Заря заново выбирает
 * бинарник: обновился `claude` — заново спросим и про флаг. `now` передаётся
 * снаружи, чтобы у теста не было зависимости от часов.
 */
export async function supportsFlag(
  exe: string,
  flag: string,
  ttlMs: number,
  now = Date.now(),
  probe: (exe: string, flag: string) => Promise<boolean> = probeFlag
): Promise<boolean> {
  const key = `${exe} ${flag}`
  const hit = flagCache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.ok
  const ok = await probe(exe, flag)
  flagCache.set(key, { ok, at: now })
  return ok
}

/**
 * Запомнить отказ, увиденный НЕ пробой, а живым запуском.
 *
 * Проба отвечает на вопрос заранее, но бинарник мог смениться между пробой и
 * запуском. Когда движок сам сказал «unknown option», это знание точнее любой
 * пробы — и оно должно пережить следующий ход, иначе человек будет получать
 * упавший запуск снова и снова.
 */
export function markFlagUnsupported(exe: string, flag: string, now = Date.now()): void {
  flagCache.set(`${exe} ${flag}`, { ok: false, at: now })
}

/** Забыть ответы пробы — для тестов и для смены бинарника. */
export function resetFlagCache(): void {
  flagCache.clear()
}

/** Флаг, которым движок отдаёт нам id хода человека (нужен откату файлов). */
export const REPLAY_FLAG = '--replay-user-messages'

export interface CheckpointDecision {
  /** Просить движок снимать копии файлов перед правками. */
  enable: boolean
  /** Сырые флаги для командной строки CLI (SDK передаёт их как есть). */
  extraArgs?: Record<string, null>
  /** Почему выключено — для честного ответа интерфейсу, а не для лога. */
  off?: 'setting' | 'unknown-exe' | 'flag-unsupported'
}

/**
 * Ставить ли чекпоинты этому ходу — и с какими флагами.
 *
 * Чистая функция от трёх фактов, потому что цена ошибки несимметрична:
 * лишний флаг убивает ЗАПУСК агента, отсутствующий — всего лишь прячет кнопку
 * отката. Поэтому «не знаем» здесь всегда значит «не ставим».
 *
 * `exeKnown: false` — это случай, когда бинарник выбирает сам SDK: спросить
 * нам не у кого, а угадывать нельзя.
 */
export function checkpointDecision(o: {
  wanted: boolean
  exeKnown: boolean
  flagSupported: boolean
}): CheckpointDecision {
  if (!o.wanted) return { enable: false, off: 'setting' }
  if (!o.exeKnown) return { enable: false, off: 'unknown-exe' }
  if (!o.flagSupported) return { enable: false, off: 'flag-unsupported' }
  return { enable: true, extraArgs: { 'replay-user-messages': null } }
}

/** First candidate path that exists on disk. */
export function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
}

/**
 * Full resolution: probe the bundled and system binaries, apply the policy.
 * `bundledPath` is supplied by the caller (it differs between dev and a
 * packaged app, which only the main process knows).
 */
export async function resolveClaudeExe(opts: {
  bundledPath?: string
  platform: string
  env: Record<string, string | undefined>
  home: string
}): Promise<ExePick> {
  const envOverride = opts.env.ZARYA_CLAUDE_BIN
  if (envOverride?.trim()) return { path: envOverride.trim(), reason: 'env' }

  const systemPath = firstExisting(systemClaudeCandidates(opts.platform, opts.env, opts.home))
  const [bundledVersion, systemVersion] = await Promise.all([
    opts.bundledPath ? probeVersion(opts.bundledPath) : Promise.resolve(undefined),
    systemPath ? probeVersion(systemPath) : Promise.resolve(undefined)
  ])

  return pickClaudeExe({
    bundled: opts.bundledPath ? { path: opts.bundledPath, version: bundledVersion } : undefined,
    system: systemPath ? { path: systemPath, version: systemVersion } : undefined
  })
}
