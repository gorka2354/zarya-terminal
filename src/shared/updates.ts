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
  return assets.find((a) => /^SHA256SUMS/i.test(a.name))
}

/** Ассеты, которые имеет смысл предлагать к скачиванию (без файла сумм). */
export function downloadableAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
  return assets.filter((a) => !/^SHA256SUMS/i.test(a.name))
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
}
