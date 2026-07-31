import { createHash } from 'crypto'
import { tm } from './lang'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { get } from 'https'
import { join } from 'path'
import { app } from 'electron'
import {
  DEFAULT_STT_MODEL,
  findSttModel,
  resolveSttModel,
  sttModelBytes,
  STT_MODELS,
  type SttModelDef
} from '@shared/sttModels'

/**
 * Local speech-to-text — dictation into the bar's input.
 *
 * Runs entirely on this machine: `sherpa-onnx` (Apache-2.0) with GigaAM v3
 * (MIT, Sber) for Russian. Nothing is uploaded, nothing is written to disk —
 * audio exists only in memory for as long as the recording lasts. That is not
 * incidental: this app has a terminal, a file tree and an agent, so a microphone
 * that phones home would be the worst thing in it.
 *
 * The addon is native but built against N-API, which is ABI-stable across
 * Node and Electron — verified loading inside Electron 43 without a rebuild.
 * Re-verify when Electron is upgraded.
 */

export interface SttProgress {
  file: string
  received: number
  total: number
}

/** Одна строка списка моделей для настроек. */
export interface SttModelState {
  id: string
  labelKey: string
  lang: string
  license: string
  noteKey: string
  bytes: number
  installed: boolean
  legacy: boolean
}

export interface SttState {
  /** Хоть одна модель скачана — диктовка работает. */
  modelReady: boolean
  /**
   * Работаем на модели прошлых версий: она без цифр, латиницы и знаков
   * препинания. Интерфейс обязан это сказать — иначе человек решит, что
   * распознавание «просто плохое», хотя нужных символов в словаре нет вовсе.
   */
  legacyModel: boolean
  /** Что реально загружено в движок сейчас. */
  activeModelId: string | null
  models: SttModelState[]
  /** Recognizer constructed and warm. */
  engineReady: boolean
  downloading: SttProgress | null
  error?: string
}

type Recognizer = {
  createStream: () => {
    acceptWaveform: (o: { sampleRate: number; samples: Float32Array }) => void
  }
  decode: (s: unknown) => void
  getResult: (s: unknown) => { text?: string }
}

export class SttService {
  private recognizer: Recognizer | null = null
  /** Какая модель выбрана человеком; задаётся из настроек при старте. */
  private selectedId = ''
  private loading: Promise<void> | null = null
  private downloading: SttProgress | null = null
  private lastError: string | undefined
  /** In-flight download shared by concurrent ensureModel() callers. */
  private downloadJob: Promise<void> | null = null

  private modelsRoot(): string {
    return join(app.getPath('userData'), 'models')
  }

  private dirOf(m: SttModelDef): string {
    return join(this.modelsRoot(), m.dir)
  }

  /** Файл засчитывается только при точном ожидаемом размере. */
  private installed(m: SttModelDef): boolean {
    return m.files.every((f) => {
      const p = join(this.dirOf(m), f.name)
      if (!existsSync(p)) return false
      try {
        return statSync(p).size === f.bytes
      } catch {
        return false
      }
    })
  }

  /** Какая модель выбрана в настройках; пусто до первой настройки. */
  private wantedId(): string {
    return this.selectedId || DEFAULT_STT_MODEL
  }

  /** Что реально грузить с учётом того, что скачано. */
  private active(): SttModelDef | null {
    return resolveSttModel(this.wantedId(), (m) => this.installed(m))
  }

  /** Выбор модели из настроек. Смена выгружает движок: он держит прежнюю в памяти. */
  select(id: string): void {
    if (id === this.selectedId) return
    this.selectedId = id
    this.recognizer = null
  }

  state(): SttState {
    const active = this.active()
    return {
      modelReady: !!active,
      legacyModel: !!active?.legacy,
      activeModelId: active?.id ?? null,
      models: STT_MODELS.filter((m) => !m.legacy || this.installed(m)).map((m) => ({
        id: m.id,
        labelKey: m.labelKey,
        lang: m.lang,
        license: m.license,
        noteKey: m.noteKey,
        bytes: sttModelBytes(m),
        installed: this.installed(m),
        legacy: !!m.legacy
      })),
      engineReady: !!this.recognizer,
      downloading: this.downloading,
      error: this.lastError
    }
  }

  /** Убрать скачанную модель с диска — она весит сотни мегабайт. */
  async removeModel(id: string): Promise<{ ok: boolean; error?: string }> {
    const m = findSttModel(id)
    if (!m) return { ok: false, error: tm('main.stt.unknownModel') }
    if (this.active()?.id === id) this.recognizer = null
    try {
      rmSync(this.dirOf(m), { recursive: true, force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : tm('main.stt.deleteFail') }
    }
  }

  /**
   * Fetch the model if missing. Every file is written to a temp name, hashed,
   * and only then moved into place — a half-downloaded 225 MB blob must never
   * look like a usable model.
   */
  async ensureModel(onProgress?: (p: SttProgress) => void, id?: string): Promise<void> {
    const m = findSttModel(id ?? this.wantedId())
    if (!m) throw new Error(tm('main.stt.unknownModel'))
    if (m.legacy) throw new Error(tm('main.stt.legacy'))
    if (this.installed(m)) return
    // Share one download between concurrent callers. Two of them would otherwise
    // write the same `.part` file at once and produce an interleaved blob that
    // fails its hash — after a 225 MB wait.
    if (this.downloadJob) return this.downloadJob
    this.downloadJob = this.downloadModel(m, onProgress).finally(() => {
      this.downloadJob = null
    })
    return this.downloadJob
  }

  private async downloadModel(
    m: SttModelDef,
    onProgress?: (p: SttProgress) => void
  ): Promise<void> {
    const dir = this.dirOf(m)
    mkdirSync(dir, { recursive: true })
    for (const f of m.files) {
      if (!f.url) throw new Error(tm('main.stt.noSource', { name: f.name }))
      const dest = join(dir, f.name)
      if (existsSync(dest) && statSync(dest).size === f.bytes) continue
      const tmp = `${dest}.part`
      try {
        await this.download(f.url, tmp, f.bytes, (received) => {
          this.downloading = { file: f.name, received, total: f.bytes }
          onProgress?.(this.downloading)
        })
        const size = statSync(tmp).size
        if (size !== f.bytes) throw new Error(tm('main.stt.sizeMismatch', { name: f.name, got: size, want: f.bytes }))
        if (f.sha256) {
          const actual = createHash('sha256').update(await readFile(tmp)).digest('hex')
          if (actual !== f.sha256) throw new Error(tm('main.stt.shaMismatch', { name: f.name }))
        }
        renameSync(tmp, dest)
      } catch (e) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          /* best-effort */
        }
        this.downloading = null
        this.lastError = e instanceof Error ? e.message : String(e)
        throw e
      }
    }
    this.downloading = null
    this.lastError = undefined
  }

  private download(
    url: string,
    dest: string,
    expected: number,
    onChunk: (received: number) => void,
    hops = 0
  ): Promise<void> {
    // A redirect loop would otherwise recurse until the stack dies instead of
    // surfacing an error.
    if (hops > 5) return Promise.reject(new Error(tm('main.upd.tooManyHops')))
    if (!url.startsWith('https://'))
      return Promise.reject(new Error(tm('main.stt.httpsOnly')))
    return new Promise((resolve, reject) => {
      const req = get(url, { headers: { 'user-agent': 'Zarya' } }, (res) => {
        // HuggingFace redirects to a CDN — and the Location can be RELATIVE
        // (`/api/resolve-cache/…`), which `get()` rejects as an invalid URL.
        // Resolve it against the current one.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          this.download(next, dest, expected, onChunk, hops + 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        let received = 0
        const out = createWriteStream(dest)
        res.on('data', (c: Buffer) => {
          received += c.length
          // Refuse to keep writing a body larger than advertised.
          if (received > expected + 1024) {
            req.destroy()
            out.destroy()
            reject(new Error(tm('main.stt.tooLong')))
            return
          }
          onChunk(received)
        })
        res.pipe(out)
        out.on('finish', () => resolve())
        out.on('error', reject)
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(120_000, () => {
        req.destroy()
        reject(new Error(tm('main.stt.timeout')))
      })
    })
  }

  /** Build the recognizer once; concurrent callers share one load. */
  private async ensureEngine(): Promise<void> {
    if (this.recognizer) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      const m = this.active()
      if (!m) throw new Error(tm('main.stt.notInstalled'))
      // Required lazily: loading the addon costs memory, and most sessions
      // never dictate anything.
      const sherpa = require('sherpa-onnx-node')
      const dir = this.dirOf(m)
      const f = (n: string): string => join(dir, n)
      // У каждого семейства своя форма конфигурации и свой набор файлов: CTC —
      // один файл, transducer — три, moonshine — четыре. Ключи проверены в
      // бинарнике аддона, а не взяты из документации.
      const modelConfig =
        m.family === 'nemoCtc'
          ? { nemoCtc: { model: f('model.int8.onnx') } }
          : m.family === 'transducer'
            ? {
                transducer: {
                  encoder: f('encoder.int8.onnx'),
                  decoder: f('decoder.onnx'),
                  joiner: f('joiner.onnx')
                }
              }
            : {
                moonshine: {
                  preprocessor: f('preprocess.onnx'),
                  encoder: f('encode.int8.onnx'),
                  uncachedDecoder: f('uncached_decode.int8.onnx'),
                  cachedDecoder: f('cached_decode.int8.onnx')
                }
              }
      const config = {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          ...modelConfig,
          tokens: f('tokens.txt'),
          numThreads: Math.max(1, Math.min(4, (require('os').cpus()?.length ?? 2) - 1)),
          provider: 'cpu',
          debug: false
        }
      }
      this.recognizer = await sherpa.OfflineRecognizer.createAsync(config)
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  }

  /**
   * Transcribe one utterance. `samples` is mono float PCM in [-1, 1] at
   * `sampleRate`; the microphone's native rate is fine — it is resampled here.
   */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    await this.ensureEngine()
    if (!this.recognizer) throw new Error(tm('main.stt.notReady'))
    let pcm = samples
    if (sampleRate !== 16000) {
      const sherpa = require('sherpa-onnx-node')
      // flush(), not resample(): this is the whole utterance, so the resampler's
      // internal tail has to come out too or the last syllable is clipped.
      const rs = new sherpa.LinearResampler(sampleRate, 16000)
      pcm = rs.flush(samples)
    }
    const stream = this.recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: pcm })
    // decodeAsync, not decode: the synchronous call is a native blocking one and
    // would freeze the whole main process — ptys, agents, IPC, window controls —
    // for as long as recognition takes. Fast on 8 cores, tens of seconds on two.
    const rec = this.recognizer as Recognizer & { decodeAsync?: (s: unknown) => Promise<void> }
    if (rec.decodeAsync) await rec.decodeAsync(stream)
    else this.recognizer.decode(stream)
    return (this.recognizer.getResult(stream).text ?? '').trim()
  }

  /** Free the recognizer (model files stay cached on disk). */
  dispose(): void {
    this.recognizer = null
  }
}
