/**
 * Проверка обновлений — разбор ответа GitHub и сборка ссылок.
 *
 * Это первое место, куда в приложение приезжает контент из сети, поэтому здесь
 * действует одно жёсткое правило: **ни один URL не берётся из ответа**. Адреса
 * собираются из константы репозитория и тега, а тег до этого проходит проверку
 * формы. Иначе достаточно подменённого или скомпрометированного ответа, чтобы
 * кнопка «Скачать» повела человека куда угодно — и он нажмёт, потому что кнопку
 * показало доверенное приложение.
 *
 * Второе правило: неизвестная форма JSON — это «проверить не удалось», а не
 * исключение и не показ мусора на экране.
 */

/** Репозиторий зашит намеренно: он не должен приезжать ни из ответа, ни из настроек. */
export const REPO = 'gorka2354/zarya-terminal'

/** Тег релиза. Всё, что не такой формы, не участвует в сборке ссылок. */
const TAG_RE = /^v\d+\.\d+\.\d+$/
/** Имя файла ассета: без слэшей и без «..», иначе ссылка уедет из релиза. */
const ASSET_RE = /^[A-Za-z0-9._-]+$/

export interface ReleaseAsset {
  name: string
  size: number
  /** Из SHA256SUMS, если он приложен к релизу. */
  sha256?: string
}

export interface ReleaseInfo {
  /** «0.5.1» — без ведущей v. */
  version: string
  tag: string
  /** Заголовок релиза; пусто — покажем версию. */
  name: string
  /** Тело релиза, markdown. Недоверенный текст: рисовать только через renderMarkdown. */
  body: string
  publishedAt: string
  assets: ReleaseAsset[]
}

/**
 * Строгое сравнение semver по числам. Не `localeCompare` и не лексикографика:
 * «0.5.10» больше «0.5.9», а по строкам вышло бы наоборот, и человек не увидел
 * бы десятый патч.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, '')
      // Пререлизный хвост (-rc.1, +build) в сравнении не участвует: свои релизы
      // мы такими не помечаем, а гадать о порядке «rc» здесь не нужно.
      .split(/[-+]/)[0]
      .split('.')
      .map((p) => {
        const n = Number.parseInt(p, 10)
        return Number.isFinite(n) ? n : 0
      })
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** Есть ли смысл предлагать обновление. */
export function isNewer(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0
}

/**
 * Разбор ответа `/releases/latest`. Возвращает null на всём, что не похоже на
 * опубликованный релиз: черновик, пререлиз, тег неизвестной формы, чужая форма
 * JSON. Молча и без исключения — вызывающему достаточно знать «нечего показать».
 */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null
  const r = json as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : ''
  if (!TAG_RE.test(tag)) return null
  const assets = Array.isArray(r.assets)
    ? r.assets
        .map((a) => {
          if (!a || typeof a !== 'object') return null
          const x = a as Record<string, unknown>
          const name = typeof x.name === 'string' ? x.name.trim() : ''
          if (!ASSET_RE.test(name)) return null
          const size = typeof x.size === 'number' && Number.isFinite(x.size) ? x.size : 0
          return { name, size }
        })
        .filter((a): a is ReleaseAsset => a !== null)
    : []
  return {
    version: tag.replace(/^v/, ''),
    tag,
    name: typeof r.name === 'string' ? r.name : '',
    body: typeof r.body === 'string' ? r.body : '',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
    assets
  }
}

/** Страница релиза. Собрана из константы и проверенного тега. */
export function releasePageUrl(tag: string): string | null {
  if (!TAG_RE.test(tag)) return null
  return `https://github.com/${REPO}/releases/tag/${tag}`
}

/** Прямая ссылка на файл релиза — тоже собирается, а не берётся из ответа. */
export function assetUrl(tag: string, name: string): string | null {
  if (!TAG_RE.test(tag) || !ASSET_RE.test(name)) return null
  return `https://github.com/${REPO}/releases/download/${tag}/${name}`
}

/** Адрес проверки. Тоже константа — чтобы его нельзя было переставить настройкой. */
export function latestReleaseApiUrl(): string {
  return `https://api.github.com/repos/${REPO}/releases/latest`
}

/**
 * Разбор `SHA256SUMS`: строки вида «<хеш>  <имя файла>». Нужен, чтобы рядом с
 * файлом показать хеш — иначе «скачайте установщик» это просьба довериться сети
 * на слово.
 */
export function parseSha256Sums(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim())
    if (!m) continue
    const name = m[2].trim()
    if (!ASSET_RE.test(name)) continue
    out[name] = m[1].toLowerCase()
  }
  return out
}

/** Файл с контрольными суммами среди ассетов релиза, если он приложен. */
export function findSumsAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  // Рядом лежит одноимённый `.sig` — тоже на SHA256SUMS. Порядок ассетов задаёт
  // GitHub, и без этой оговорки за список сумм можно принять файл подписи.
  return assets.find((a) => /^SHA256SUMS/i.test(a.name) && !/\.sig$/i.test(a.name))
}

/** Подпись списка сумм — то, чего нет и не может быть у CI. */
export function findSigAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((a) => /^SHA256SUMS.*\.sig$/i.test(a.name))
}

/**
 * Итог проверки подписи релиза.
 *
 * 'ok' — список сумм подписан ключом мейнтейнера; 'missing' — подписи к релизу
 * нет; 'bad' — подпись есть, но не сходится. Разница видна пользователю: первое
 * разрешает установку одним нажатием, остальные оставляют ручной путь. Само
 * ключевое хозяйство живёт в main (src/main/releaseSignature.ts) — сюда вынесен
 * только словарь, потому что состояние показывает рендерер.
 */
export type ReleaseSignature = 'ok' | 'missing' | 'bad'

/**
 * Служебные файлы релиза — не для человека.
 *
 * `latest*.yml` читает обновлятор, `.blockmap` нужен для разностного
 * скачивания, `SHA256SUMS` показывается рядом с каждым файлом отдельной
 * строкой. Показывать их в списке «Файлы» значит предлагать скачать килобайт
 * метаданных наравне со сборкой — список из десяти строк, где полезны две.
 */
export function isServiceAsset(name: string): boolean {
  return /^SHA256SUMS/i.test(name) || /^latest.*\.yml$/i.test(name) || /\.blockmap$/i.test(name)
}

/** Ассеты, которые имеет смысл предлагать к скачиванию. */
export function downloadableAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
  return assets.filter((a) => !isServiceAsset(a.name))
}

/** Для какой системы этот файл. null — не определяется по имени. */
export function assetPlatform(name: string): 'win32' | 'darwin' | 'linux' | null {
  if (/\.exe$/i.test(name)) return 'win32'
  if (/\.dmg$/i.test(name) || /\.zip$/i.test(name)) return 'darwin'
  if (/\.AppImage$/i.test(name) || /\.deb$/i.test(name) || /\.rpm$/i.test(name)) return 'linux'
  return null
}

/**
 * Разложить файлы на «для этой системы» и «для остальных».
 *
 * Пользователю Windows не нужны dmg, AppImage и deb — это четыре лишние строки
 * из пяти. Но прятать их совсем нельзя: страница релиза одна на все системы, и
 * человек может качать для другой машины.
 */
export function splitByPlatform(
  assets: ReleaseAsset[],
  platform: string
): { mine: ReleaseAsset[]; others: ReleaseAsset[] } {
  const mine: ReleaseAsset[] = []
  const others: ReleaseAsset[] = []
  for (const a of downloadableAssets(assets)) {
    const p = assetPlatform(a.name)
    // Неопознанное имя показываем как своё: лучше лишняя строка, чем спрятанный
    // файл, который человек ищет.
    ;(p === null || p === platform ? mine : others).push(a)
  }
  return { mine, others }
}

/** Состояние проверки — то, что видит рендерер. Живёт здесь, а не в main: preload и окно не должны тянуть код main-процесса. */
export interface UpdateState {
  /** Версия установленного приложения. */
  current: string
  /** Последний опубликованный релиз, если проверка удалась. */
  latest?: ReleaseInfo & { sums: Record<string, string> }
  /** Есть ли что предлагать. */
  updateAvailable: boolean
  /** Когда проверяли (мс). */
  checkedAt?: number
  /** Почему не удалось — короткой строкой для статуса, без всплывашек. */
  error?: string
  checking: boolean

  /**
   * Умеет ли эта сборка поставить обновление сама.
   *
   * Windows — да. AppImage — да. macOS без подписи и нотаризации — НЕТ:
   * Squirrel.Mac отказывается ставить неподписанное. Пакет .deb ставится
   * менеджером пакетов, а не приложением. Там, где нельзя, интерфейс обязан
   * предложить ручной путь, а не серую кнопку без объяснения.
   */
  canInstall: boolean
  /** Идёт скачивание: доля 0..100 и байты — для полосы прогресса. */
  downloading?: { percent: number; transferred: number; total: number }
  /** Файл скачан и проверен по sha512 — осталось перезапуститься. */
  downloaded: boolean
  /**
   * Подписан ли список контрольных сумм этого релиза (см. {@link ReleaseSignature}).
   * Без валидной подписи приложение не ставит обновление само: хеш, посчитанный
   * той же машиной, что и собрала, ничего не доказывает.
   */
  signature?: ReleaseSignature
  /** Скачивание или установка не удались. */
  installError?: string
  /** На какой системе мы работаем — чтобы показать нужный файл первым. */
  platform: string
}

/** Версия из имени файла сборки: «Zarya-Setup-0.5.6-win-x64.exe» → «0.5.6». */
export function versionFromFileName(name: string): string | null {
  // Разделители у разных упаковщиков разные: NSIS даёт «Zarya-Setup-0.5.6-win»,
  // а dpkg — «zarya-terminal_0.5.6_amd64». Одна регулярка на оба случая.
  const m = /[-_](\d+\.\d+\.\d+)(?=[-_.])/.exec(name)
  return m ? m[1] : null
}

/**
 * Какие файлы в кеше обновлятора уже не нужны.
 *
 * electron-updater не убирает за собой: после установки в кеше остаются ДВЕ
 * копии установщика (сам скачанный файл и его копия для запуска) — на нашей
 * сборке это 365 МБ, и так после каждого обновления. Удалять можно только когда
 * в кеше нет ничего новее установленной версии: иначе снесём обновление,
 * которое человек уже скачал, но ещё не поставил, и его придётся качать заново.
 *
 * Мелочь вроде .blockmap (сотни килобайт) остаётся — она ускоряет следующее
 * разностное скачивание.
 */
export function staleUpdaterFiles(names: string[], currentVersion: string): string[] {
  const heavy = names.filter((n) => /\.(exe|dmg|AppImage|deb|zip)$/i.test(n))
  const pendingNewer = heavy.some((n) => {
    const v = versionFromFileName(n)
    return v !== null && compareVersions(v, currentVersion) > 0
  })
  return pendingNewer ? [] : heavy
}
