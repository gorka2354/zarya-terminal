/**
 * Здоровье движка: что запускается, откуда и что с ним не так.
 *
 * Когда Claude Code сломан, Заря выглядит сломанной. Два разных `claude` в
 * системе, битая запятая в чужом `settings.json`, протухший вход — снаружи всё
 * это одинаково: агент не отвечает или отвечает не тем. Человек чинит Зарю,
 * которая не виновата.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Свой диагноз мы ставим только тому, что знаем
 * достоверно: какие исполняемые файлы нашлись, какой из них выбран и почему.
 * Всё остальное умеет сказать сам движок (`claude doctor`), и его отчёт
 * показывается ДОСЛОВНО, без нашего пересказа и без нашего вердикта поверх.
 *
 * Причина не в лени. Отчёт движка внутренне противоречив: он печатает раздел
 * «Invalid settings» с настоящей находкой и следом строку «No installation
 * issues found». Свести это в одно наше слово — значит выбрать, какую из двух
 * его фраз объявить правдой; показать как есть — значит не соврать ни в одну
 * сторону. Разбирать его текст мы тоже не беремся: он человеческий, меняется с
 * версией, и разбор молча начал бы врать на следующей.
 */
import { execFile } from 'child_process'
import type { ExePick, ExeReason } from './claudeExe'

/** Один найденный `claude`. */
export interface EngineBinary {
  path: string
  /** «2.1.226». Пусто — файл есть, а версию узнать не вышло. */
  version?: string
  /**
   * Откуда он взялся: `bundled` — приехал с Зарёй, `system` — установлен
   * человеком и обновляется сам, `env` — задан переменной окружения.
   */
  origin: 'bundled' | 'system' | 'env'
  /** Именно этот и запускается. */
  chosen: boolean
}

export interface EngineHealth {
  /** Все найденные — чтобы «какой из двух» перестало быть загадкой. */
  binaries: EngineBinary[]
  /** Почему выбран этот. Ключ, а не фраза: переводит окно. */
  reason: ExeReason
  /** Кто вошёл. `null` — движок не ответил или ответил не тем. */
  auth?: AgentAuth | null
  /** Отчёт движка о себе. Приходит только по нажатию: это запуск процесса. */
  doctor?: { ok: true; text: string } | { ok: false; error: string }
}

function ver(v?: number[]): string | undefined {
  return v?.length ? v.join('.') : undefined
}

/**
 * Собрать список найденного и отметить выбранный.
 *
 * Чистая: решение о выборе принимает `pickClaudeExe`, здесь оно только
 * пересказывается человеку. Сверять по ПУТИ, а не пересчитывать политику
 * заново — иначе окно однажды покажет не тот файл, который на самом деле
 * запускается, и это будет худшая из возможных ошибок такого экрана.
 */
export function buildBinaries(
  pick: ExePick,
  found: {
    bundled?: { path: string; version?: number[] }
    system?: { path: string; version?: number[] }
  },
  envOverride?: string
): EngineBinary[] {
  const out: EngineBinary[] = []
  const same = (p: string): boolean => !!pick.path && norm(pick.path) === norm(p)
  if (envOverride?.trim()) {
    out.push({ path: envOverride.trim(), origin: 'env', chosen: same(envOverride.trim()) })
  }
  if (found.system) {
    out.push({
      path: found.system.path,
      version: ver(found.system.version),
      origin: 'system',
      chosen: same(found.system.path)
    })
  }
  if (found.bundled) {
    out.push({
      path: found.bundled.path,
      version: ver(found.bundled.version),
      origin: 'bundled',
      chosen: same(found.bundled.path)
    })
  }
  return out
}

/** Пути сравниваем без учёта регистра и вида разделителя: Windows. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Спросить движок о нём самом.
 *
 * `claude doctor` документирован как чтение: «Reads settings files in the
 * current directory without a trust prompt». Папку передаём панельную — иначе
 * проверялись бы настройки не того проекта, и «всё в порядке» относилось бы к
 * чужому каталогу.
 *
 * Живёт секунды и запускает процесс, поэтому вызывается только с нажатия.
 */
export function runDoctor(
  exe: string,
  cwd: string | undefined,
  timeoutMs = 30_000
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (r: { ok: true; text: string } | { ok: false; error: string }): void => {
      if (!done) {
        done = true
        resolve(r)
      }
    }
    try {
      execFile(
        exe,
        ['doctor'],
        { timeout: timeoutMs, cwd, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          const text = `${stdout ?? ''}${stderr ?? ''}`.trim()
          /*
           * Ненулевой код выхода при непустом отчёте — не повод прятать отчёт:
           * `doctor` вправе сообщить о находках именно так, и его слова нужны
           * человеку больше, чем наше «не удалось».
           */
          if (text) return finish({ ok: true, text })
          finish({ ok: false, error: err ? String(err.message ?? err) : 'пустой ответ' })
        }
      ).on('error', (e) => finish({ ok: false, error: String(e.message ?? e) }))
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** Ключ словаря для причины выбора — чтобы окно не сочиняло свою формулировку. */
export function reasonKey(reason: ExeReason): string {
  return `eng.reason.${reason}`
}

/**
 * Разобрать ответ `claude auth status --json`.
 *
 * Отдельно от запуска, чтобы проверить построчно: дождаться протухшего токена в
 * прогоне нечем, а «вошли не тем аккаунтом» — самая обидная из причин, по
 * которым агент отвечает не то.
 *
 * Берём ЧЕТЫРЕ поля из семи. Остальные — идентификатор организации и признак
 * провайдера — на вопрос «почему движок ведёт себя не так» не отвечают, а
 * экран настроек попадает на скриншоты.
 */
export function parseAuth(raw: string): AgentAuth | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || typeof o.loggedIn !== 'boolean') return null
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  return {
    loggedIn: o.loggedIn,
    method: str(o.authMethod),
    email: str(o.email),
    plan: str(o.subscriptionType)
  }
}

/** Кто вошёл. `null` — движок не ответил или ответил не тем. */
export interface AgentAuth {
  loggedIn: boolean
  method?: string
  email?: string
  plan?: string
}

/**
 * Спросить движок, кто вошёл. Полсекунды и без сети наружу от нас — просто
 * читает то, что CLI и так знает о себе.
 */
export function readAuth(exe: string, timeoutMs = 10_000): Promise<AgentAuth | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: AgentAuth | null): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      execFile(
        exe,
        ['auth', 'status', '--json'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
        (_err, stdout) => finish(parseAuth(String(stdout ?? '')))
      ).on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}
