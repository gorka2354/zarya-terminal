import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readJson, writeJsonAtomic, mergeDeep, debounce } from './jsonStore'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AiProviderKind, AiProviderStatus, Settings } from '@shared/types'

type Listener = (s: Settings) => void

export class SettingsStore {
  private settings: Settings = DEFAULT_SETTINGS
  private secrets: Record<string, string> = {}
  private listeners = new Set<Listener>()
  private persist = debounce(() => {
    void writeJsonAtomic(this.file, this.settings)
  }, 250)

  private get file() {
    return join(app.getPath('userData'), 'settings.json')
  }
  private get secretsFile() {
    return join(app.getPath('userData'), 'secrets.json')
  }

  async init(): Promise<void> {
    const stored = await readJson<Partial<Settings>>(this.file, {})
    this.settings = mergeDeep(DEFAULT_SETTINGS, stored)
    this.secrets = await readJson<Record<string, string>>(this.secretsFile, {})
  }

  get(): Settings {
    return this.settings
  }

  set(patch: Partial<Settings>): Settings {
    this.settings = mergeDeep(this.settings, patch)
    this.persist()
    for (const l of this.listeners) l(this.settings)
    return this.settings
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Store an API key encrypted with the OS keychain (DPAPI on Windows). */
  async setSecret(provider: AiProviderKind, key: string): Promise<void> {
    if (!key) {
      delete this.secrets[provider]
    } else if (safeStorage.isEncryptionAvailable()) {
      this.secrets[provider] = 'enc:' + safeStorage.encryptString(key).toString('base64')
    } else {
      // Fallback: plain base64 (still better than nothing; flagged in UI).
      this.secrets[provider] = 'b64:' + Buffer.from(key, 'utf8').toString('base64')
    }
    await writeJsonAtomic(this.secretsFile, this.secrets)
  }

  getSecret(provider: AiProviderKind): string | undefined {
    const stored = this.secrets[provider]
    if (!stored) return undefined
    try {
      if (stored.startsWith('enc:')) {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      }
      if (stored.startsWith('b64:')) {
        return Buffer.from(stored.slice(4), 'base64').toString('utf8')
      }
    } catch {
      return undefined
    }
    return undefined
  }

  providerStatus(): AiProviderStatus[] {
    const kinds: AiProviderKind[] = ['anthropic', 'openai', 'ollama', 'openai-compat']
    return kinds.map((provider) => ({ provider, hasKey: !!this.secrets[provider] }))
  }
}
