import { app } from 'electron'
import { join } from 'path'
import { MODELS_MAX, type ProviderCatalog } from '@shared/modelCatalog'
import { readJson, writeJsonAtomic } from './jsonStore'

/**
 * Последний известный каталог моделей — по провайдеру.
 *
 * Нужен, чтобы пусковой комплекс открывался мгновенно и работал без сети: люди
 * выбирают модель чаще, чем провайдеры выпускают новые, и заставлять человека
 * ждать сетевой запрос ради списка, который не менялся неделю, — плохой размен.
 *
 * Файл маленький и ограниченный: провайдер → список идентификаторов и время
 * получения. Ничего, что растёт само по себе.
 */
type CatalogFile = Record<string, { ids: string[]; at: number }>

const EMPTY: ProviderCatalog = { ids: [], at: 0 }

export class ModelCatalogStore {
  private get file(): string {
    return join(app.getPath('userData'), 'model-catalog.json')
  }

  private cache: CatalogFile | null = null

  private async read(): Promise<CatalogFile> {
    if (!this.cache) this.cache = await readJson<CatalogFile>(this.file, {})
    return this.cache
  }

  /** Что известно про провайдера сейчас. Пустой каталог — «не спрашивали». */
  async get(provider: string): Promise<ProviderCatalog> {
    const all = await this.read()
    const row = all[provider]
    return row ? { ids: row.ids, at: row.at } : EMPTY
  }

  /** Запомнить свежий каталог и вернуть его же — вызывающему нужен результат. */
  async put(provider: string, ids: string[]): Promise<ProviderCatalog> {
    const all = await this.read()
    const next: ProviderCatalog = { ids: ids.slice(0, MODELS_MAX), at: Date.now() }
    all[provider] = { ids: next.ids, at: next.at }
    this.cache = all
    await writeJsonAtomic(this.file, all)
    return next
  }
}
