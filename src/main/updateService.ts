import { get } from 'https'
import {
  findSumsAsset,
  latestReleaseApiUrl,
  parseRelease,
  parseSha256Sums,
  assetUrl,
  isNewer,
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

export class UpdateService {
  private state: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  /** Один запрос в полёте: два нажатия «Проверить» не должны идти в сеть дважды. */
  private inFlight: Promise<UpdateState> | null = null

  constructor(private currentVersion: string) {
    this.state = { current: currentVersion, updateAvailable: false, checking: false }
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
