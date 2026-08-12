import { get } from 'https'
import { tm } from './lang'
import { autoUpdater } from 'electron-updater'
import { readFile, readdir, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

/** Каталог кеша обновлятора; значение из app-update.yml (updaterCacheDirName). */
const UPDATER_CACHE_DIR = 'zarya-terminal-updater'
import {
  findSigAsset,
  findSumsAsset,
  latestReleaseApiUrl,
  parseRelease,
  parseSha256Sums,
  assetUrl,
  isNewer,
  REPO,
  staleUpdaterFiles,
  type ReleaseInfo,
  type ReleaseSignature,
  type UpdateState
} from '@shared/updates'
import { sha256Hex, verifyManifest } from './releaseSignature'

/**
 * Проверка обновлений.
 *
 * Живёт в main, а не в рендерере, намеренно: сеть — вне окна, у запроса есть
 * таймаут и потолок на размер ответа, а рендереру достаётся уже разобранный
 * результат. Ни один адрес не берётся из ответа сервера (см. `@shared/updates`).
 *
 * Запрос анонимный: без токена, без идентификатора машины, без счётчиков. Один
 * раз при запуске плюс по явному нажатию — никакого фонового опроса.
 */

/** Ответ GitHub на релиз — десятки килобайт. Всё, что больше, читать незачем. */
const MAX_BODY = 512 * 1024
const TIMEOUT_MS = 8000

/** Куда вообще разрешено ходить за обновлением — включая цепочку редиректов. */
const TRUSTED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com'
])
function isTrustedHost(url: string): boolean {
  try {
    return TRUSTED_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Может ли эта сборка поставить обновление сама.
 *
 * Windows (NSIS) — да, подпись для этого не требуется: целостность скачанного
 * проверяется по sha512 из latest.yml. macOS — НЕТ: Squirrel.Mac ставит только
 * подписанное и нотаризованное, а наши сборки не подписаны, и попытка кончилась
 * бы невнятной ошибкой вместо честного «поставьте руками». Linux: AppImage
 * обновляется сам, .deb ставится менеджером пакетов.
 */
function canSelfInstall(): boolean {
  if (process.platform === 'win32') {
    // Переносимая сборка обновиться НЕ может: electron-builder намеренно не
    // пишет для неё метаданные (isWriteUpdateInfo: !isPortable), и установщик
    // поставил бы рядом ВТОРУЮ, обычную копию приложения вместо обновления
    // запущенного файла. Кнопка «Установить» здесь была бы враньём — переменную
    // ставит сам portable-лаунчер.
    return !process.env.PORTABLE_EXECUTABLE_FILE
  }
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

export class UpdateService {
  private state: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  /** Один запрос в полёте: два нажатия «Проверить» не должны идти в сеть дважды. */
  private inFlight: Promise<UpdateState> | null = null
  /** Вызывается, когда пользователь подтвердил установку: гасит приложение штатно. */
  private quitForInstall: (() => void) | null = null

  constructor(private currentVersion: string) {
    this.state = {
      current: currentVersion,
      updateAvailable: false,
      checking: false,
      canInstall: canSelfInstall(),
      downloaded: false,
      platform: process.platform
    }
    // Ничего не качаем и не ставим в фоне: обновление начинается только с
    // явного нажатия. Приложение, которое само меняет свой исполняемый файл,
    // пока человек работает, — не то, чем должен быть терминал.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    // Источник задаётся явно из той же константы REPO, что и все остальные
    // адреса. По умолчанию electron-updater взял бы его из app-update.yml,
    // который печётся в сборку отдельным путём: две независимые истины о том,
    // откуда приходит код, — на одну больше, чем нужно.
    const [owner, repo] = REPO.split('/')
    autoUpdater.setFeedURL({ provider: 'github', owner, repo })
    autoUpdater.on('download-progress', (p) => {
      this.set({
        downloading: {
          percent: Math.max(0, Math.min(100, p.percent)),
          transferred: p.transferred,
          total: p.total
        }
      })
    })
    // 'update-downloaded' НЕ объявляет обновление готовым: файл ещё не сверен с
    // подписанным списком сумм. Флаг ставит download() после проверки — иначе
    // кнопка «Установить» загоралась бы на непроверенном файле.
    autoUpdater.on('update-downloaded', () => {
      this.set({ downloading: undefined })
    })
    autoUpdater.on('error', (e) => {
      this.set({
        downloading: undefined,
        installError: e instanceof Error ? e.message : tm('main.upd.downloadFail')
      })
    })
  }

  /**
   * Убрать за обновлятором.
   *
   * После установки в его кеше остаются ДВЕ копии установщика — замерено на
   * живой машине после обновления 0.5.5 → 0.5.6: 382 МБ. Сам electron-updater
   * чистит кеш только в начале СЛЕДУЮЩЕГО скачивания (AppUpdater.js:609,
   * removeFileIfAny), то есть до тех пор место занято. Приложение, держащее
   * треть гигабайта между обновлениями, — плохой сосед.
   */
  async cleanCache(): Promise<number> {
    // QA-прогоны поднимают собранное приложение с временным ZARYA_USER_DATA, но
    // кеш обновлятора лежит В ДРУГОМ месте и подменой userData не изолируется.
    // Без этой проверки тест удалял файлы из НАСТОЯЩЕЙ папки пользователя —
    // именно так и случилось при первом же прогоне. Тест не должен трогать
    // ничего за пределами своей песочницы.
    if (process.env.ZARYA_USER_DATA) return 0
    // Путь считается ровно так же, как в самом electron-updater
    // (out/AppAdapter.js: getAppCacheDir) — иначе мы бы чистили не ту папку и
    // молча ничего не делали. Имя каталога берётся из app-update.yml.
    const cacheRoot =
      process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Caches')
          : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'))
    const base = join(cacheRoot, UPDATER_CACHE_DIR)
    let freed = 0
    try {
      const entries = await readdir(base, { recursive: true, withFileTypes: true })
      const files = entries.filter((e) => e.isFile())
      const stale = new Set(
        staleUpdaterFiles(
          files.map((e) => e.name),
          this.currentVersion
        )
      )
      for (const e of files) {
        if (!stale.has(e.name)) continue
        const full = join(e.parentPath ?? base, e.name)
        try {
          freed += (await stat(full)).size
          await unlink(full)
        } catch {
          /* занят или уже удалён — не беда */
        }
      }
    } catch {
      /* кеша нет — убирать нечего */
    }
    return freed
  }

  /** Как гасить приложение перед установкой — задаётся из main. */
  onQuitForInstall(fn: () => void): void {
    this.quitForInstall = fn
  }

  /**
   * Скачать обновление. Прогресс уезжает в состояние; целостность проверяется
   * дважды: electron-updater сверяет sha512 из latest.yml (защита от битой
   * закачки), а мы — sha256 из ПОДПИСАННОГО списка сумм (защита от подменённой
   * сборки, которую latest.yml подтвердил бы сам себе).
   */
  async download(): Promise<UpdateState> {
    if (!this.state.canInstall) {
      this.set({ installError: tm('main.upd.noSelfInstall') })
      return this.state
    }
    // Без подписи ставить нечего: sha512 из latest.yml посчитал тот же CI, что и
    // собрал, — при захвате сборки он будет валидным. Ручной путь со страницы
    // релиза остаётся, но одним нажатием такое не ставим.
    if (this.state.signature !== 'ok') {
      this.set({
        installError:
          this.state.signature === 'bad' ? tm('main.upd.sigMismatch') : tm('main.upd.unsigned')
      })
      return this.state
    }
    this.set({
      installError: undefined,
      downloaded: false,
      downloading: { percent: 0, transferred: 0, total: 0 }
    })
    try {
      await autoUpdater.checkForUpdates()
      const files = await autoUpdater.downloadUpdate()
      const bad = await this.mismatchedFile(files)
      if (bad) {
        this.set({ downloading: undefined, downloaded: false, installError: bad })
        return this.state
      }
      this.set({ downloading: undefined, downloaded: true, installError: undefined })
    } catch (e) {
      this.set({
        downloading: undefined,
        installError: e instanceof Error ? e.message : tm('main.upd.downloadFail')
      })
    }
    return this.state
  }

  /**
   * Сверить скачанное с ПОДПИСАННЫМ списком сумм.
   *
   * Это и есть та единственная нить, по которой доверие доходит до файла на
   * диске: подпись мейнтейнера → список сумм → sha256 установщика. Проверку
   * electron-updater по sha512 из latest.yml она не заменяет, а достраивает:
   * latest.yml пишет CI, и подтвердить он может только сам себя.
   *
   * Возвращает текст ошибки или undefined, если всё сошлось.
   */
  private async mismatchedFile(files: string[]): Promise<string | undefined> {
    const sums = this.state.latest?.sums ?? {}
    // Скачанного установщика может не оказаться в списке путей: разностное
    // скачивание отдаёт .blockmap и промежуточные файлы. Проверяем те, что
    // выглядят как сборка.
    const installers = files.filter((f) => /\.(exe|appimage|deb|dmg|zip)$/i.test(f))
    if (!installers.length) return tm('main.upd.unknownFiles')
    for (const file of installers) {
      const name = basename(file)
      const want = sums[name]
      if (!want) return tm('main.upd.notInList', { name })
      let got: string
      try {
        got = sha256Hex(await readFile(file))
      } catch {
        return tm('main.upd.unreadable', { name })
      }
      if (got !== want) {
        // Файл, не сошедшийся с подписанным списком, не должен остаться лежать
        // рядом с настоящими: следующая установка не должна его подхватить.
        try {
          await unlink(file)
        } catch {
          /* не вышло — хотя бы не ставим */
        }
        return tm('main.upd.shaMismatch', { name })
      }
    }
    return undefined
  }

  /**
   * Поставить и перезапуститься.
   *
   * Гасим приложение ТЕМ ЖЕ путём, что и обычное закрытие: рендерер успевает
   * снять снимки сессий, настройки сбрасываются на диск, агенты и pty убиваются.
   * Иначе обновление стоило бы человеку открытых терминалов.
   */
  install(): { ok: boolean; error?: string } {
    if (!this.state.downloaded) return { ok: false, error: tm('main.upd.notDownloaded') }
    if (!this.quitForInstall) return { ok: false, error: tm('main.upd.noQuit') }
    this.quitForInstall()
    return { ok: true }
  }

  /** Запустить установщик — вызывается ПОСЛЕ штатного завершения. */
  runInstaller(): void {
    // isSilent: установщик отработает без мастера; isForceRunAfter: приложение
    // поднимется обратно уже обновлённым.
    autoUpdater.quitAndInstall(true, true)
  }

  get(): UpdateState {
    return this.state
  }

  onChange(l: (s: UpdateState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  async check(): Promise<UpdateState> {
    if (this.inFlight) return this.inFlight
    this.set({ checking: true, error: undefined })
    this.inFlight = this.run()
      .catch((e: unknown) => {
        // Сеть отвалилась — это не авария приложения. Строка в статусе, и всё:
        // всплывашка «не удалось проверить обновления» на каждом запуске без
        // интернета была бы наказанием за отсутствие сети.
        this.set({
          checking: false,
          checkedAt: Date.now(),
          error: e instanceof Error ? e.message : tm('main.upd.checkFail')
        })
        return this.state
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private async run(): Promise<UpdateState> {
    const json = await this.fetchJson(latestReleaseApiUrl())
    const rel = parseRelease(json)
    if (!rel) {
      this.set({ checking: false, checkedAt: Date.now(), error: tm('main.upd.badRelease') })
      return this.state
    }
    // Контрольные суммы — необязательная роскошь для ПОКАЗА: нет файла или не
    // скачался, релиз всё равно показываем, просто без хешей. Но для установки
    // одним нажатием они обязательны и обязаны быть подписаны — см. ниже.
    let sums: Record<string, string> = {}
    let signature: ReleaseSignature = 'missing'
    const sumsAsset = findSumsAsset(rel.assets)
    if (sumsAsset) {
      const url = assetUrl(rel.tag, sumsAsset.name)
      if (url) {
        try {
          const text = await this.fetchText(url)
          sums = parseSha256Sums(text)
          // Подпись ставится ключом, которого нет в CI, поэтому её отсутствие —
          // не сбой сети, а «релиз не подписали». Разница видна пользователю.
          const sigAsset = findSigAsset(rel.assets)
          let sigText: string | undefined
          if (sigAsset) {
            const sigUrl = assetUrl(rel.tag, sigAsset.name)
            if (sigUrl) sigText = await this.fetchText(sigUrl)
          }
          signature = verifyManifest(text, sigText)
        } catch {
          sums = {}
          signature = 'missing'
        }
      }
    }
    this.set({
      checking: false,
      checkedAt: Date.now(),
      error: undefined,
      latest: { ...rel, sums },
      signature,
      updateAvailable: isNewer(this.currentVersion, rel.version)
    })
    return this.state
  }

  private async fetchJson(url: string): Promise<unknown> {
    const text = await this.fetchText(url)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(tm('main.upd.notJson'))
    }
  }

  /** https-only, с таймаутом, потолком на размер и ограничением на редиректы. */
  private fetchText(url: string, hops = 0): Promise<string> {
    if (hops > 3) return Promise.reject(new Error(tm('main.upd.tooManyHops')))
    if (!url.startsWith('https://')) return Promise.reject(new Error(tm('main.upd.httpsOnly')))
    // Ходим только к GitHub. Раньше редирект мог увести куда угодно: при
    // TLS-инспекции с локально доверенным корнем (корпоративный прокси,
    // заражённая машина) подменённый Location увёл бы проверку на чужой хост, и
    // приложение показало бы его ответ как «описание нового релиза».
    if (!isTrustedHost(url)) return Promise.reject(new Error(tm('main.upd.untrustedHost')))
    return new Promise((resolve, reject) => {
      const req = get(
        url,
        {
          headers: {
            // GitHub требует User-Agent. Никаких идентификаторов машины в нём нет.
            'user-agent': 'Zarya',
            accept: 'application/vnd.github+json'
          }
        },
        (res) => {
          const code = res.statusCode ?? 0
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume()
            // Относительный Location — обычное дело у CDN GitHub.
            const next = new URL(res.headers.location, url).toString()
            this.fetchText(next, hops + 1).then(resolve, reject)
            return
          }
          if (code !== 200) {
            res.resume()
            reject(new Error(`HTTP ${code}`))
            return
          }
          let size = 0
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => {
            size += c.length
            if (size > MAX_BODY) {
              req.destroy()
              reject(new Error(tm('main.upd.tooBig')))
              return
            }
            chunks.push(c)
          })
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          res.on('error', reject)
        }
      )
      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy(new Error(tm('main.upd.timeout')))
      })
      req.on('error', reject)
    })
  }
}
