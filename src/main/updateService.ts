import { get } from 'https'
import { autoUpdater } from 'electron-updater'
import {
  findSumsAsset,
  latestReleaseApiUrl,
  parseRelease,
  parseSha256Sums,
  assetUrl,
  isNewer,
  REPO,
  type ReleaseInfo,
  type UpdateState
} from '@shared/updates'

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
    autoUpdater.on('update-downloaded', () => {
      this.set({ downloading: undefined, downloaded: true, installError: undefined })
    })
    autoUpdater.on('error', (e) => {
      this.set({
        downloading: undefined,
        installError: e instanceof Error ? e.message : 'не удалось скачать обновление'
      })
    })
  }

  /** Как гасить приложение перед установкой — задаётся из main. */
  onQuitForInstall(fn: () => void): void {
    this.quitForInstall = fn
  }

  /**
   * Скачать обновление. Прогресс уезжает в состояние, целостность проверяет сам
   * electron-updater по sha512 из latest.yml.
   */
  async download(): Promise<UpdateState> {
    if (!this.state.canInstall) {
      this.set({ installError: 'эта сборка не умеет ставить обновление сама' })
      return this.state
    }
    this.set({ installError: undefined, downloaded: false, downloading: { percent: 0, transferred: 0, total: 0 } })
    try {
      await autoUpdater.checkForUpdates()
      await autoUpdater.downloadUpdate()
    } catch (e) {
      this.set({
        downloading: undefined,
        installError: e instanceof Error ? e.message : 'не удалось скачать обновление'
      })
    }
    return this.state
  }

  /**
   * Поставить и перезапуститься.
   *
   * Гасим приложение ТЕМ ЖЕ путём, что и обычное закрытие: рендерер успевает
   * снять снимки сессий, настройки сбрасываются на диск, агенты и pty убиваются.
   * Иначе обновление стоило бы человеку открытых терминалов.
   */
  install(): { ok: boolean; error?: string } {
    if (!this.state.downloaded) return { ok: false, error: 'обновление ещё не скачано' }
    if (!this.quitForInstall) return { ok: false, error: 'нечем завершить приложение' }
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
          error: e instanceof Error ? e.message : 'не удалось проверить'
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
      this.set({ checking: false, checkedAt: Date.now(), error: 'релиз не распознан' })
      return this.state
    }
    // Контрольные суммы — необязательная роскошь: нет файла или не скачался,
    // релиз всё равно показываем, просто без хешей.
    let sums: Record<string, string> = {}
    const sumsAsset = findSumsAsset(rel.assets)
    if (sumsAsset) {
      const url = assetUrl(rel.tag, sumsAsset.name)
      if (url) {
        try {
          sums = parseSha256Sums(await this.fetchText(url))
        } catch {
          sums = {}
        }
      }
    }
    this.set({
      checking: false,
      checkedAt: Date.now(),
      error: undefined,
      latest: { ...rel, sums },
      updateAvailable: isNewer(this.currentVersion, rel.version)
    })
    return this.state
  }

  private async fetchJson(url: string): Promise<unknown> {
    const text = await this.fetchText(url)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('ответ не является JSON')
    }
  }

  /** https-only, с таймаутом, потолком на размер и ограничением на редиректы. */
  private fetchText(url: string, hops = 0): Promise<string> {
    if (hops > 3) return Promise.reject(new Error('слишком много перенаправлений'))
    if (!url.startsWith('https://')) return Promise.reject(new Error('только https'))
    // Ходим только к GitHub. Раньше редирект мог увести куда угодно: при
    // TLS-инспекции с локально доверенным корнем (корпоративный прокси,
    // заражённая машина) подменённый Location увёл бы проверку на чужой хост, и
    // приложение показало бы его ответ как «описание нового релиза».
    if (!isTrustedHost(url)) return Promise.reject(new Error('недоверенный источник обновления'))
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
              reject(new Error('ответ слишком большой'))
              return
            }
            chunks.push(c)
          })
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          res.on('error', reject)
        }
      )
      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy(new Error('таймаут проверки обновлений'))
      })
      req.on('error', reject)
    })
  }
}
