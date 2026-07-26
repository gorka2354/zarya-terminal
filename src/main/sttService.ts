import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { get } from 'https'
import { join } from 'path'
import { app } from 'electron'

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

/** Where the model lives, and what it must hash to. */
const MODEL = {
  dir: 'gigaam-v3-ru',
  /**
   * SECURITY: the source is fixed in code and never taken from the renderer.
   * A settable URL would be a «download anything to anywhere» primitive, and
   * the payload here is a file we then hand to a native runtime.
   */
  files: [
    {
      name: 'model.int8.onnx',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/resolve/main/model.int8.onnx',
      bytes: 224721476,
      sha256: 'f86ebfa0429ced91be6054fc344827e9c6c2572f3c318416cd974b06f66437ec'
    },
    {
      name: 'tokens.txt',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/resolve/main/tokens.txt',
      bytes: 196,
      sha256: null as string | null // tiny, not LFS-hashed upstream; size-checked
    }
  ]
} as const

export interface SttProgress {
  file: string
  received: number
  total: number
}

export interface SttState {
  /** Model files present and verified. */
  modelReady: boolean
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
  private loading: Promise<void> | null = null
  private downloading: SttProgress | null = null
  private lastError: string | undefined
  /** In-flight download shared by concurrent ensureModel() callers. */
  private downloadJob: Promise<void> | null = null

  private modelDir(): string {
    return join(app.getPath('userData'), 'models', MODEL.dir)
  }

  private filePath(name: string): string {
    return join(this.modelDir(), name)
  }

  /** A file counts as present only at the exact expected size. */
  private present(): boolean {
    return MODEL.files.every((f) => {
      const p = this.filePath(f.name)
      if (!existsSync(p)) return false
      try {
        return statSync(p).size === f.bytes
      } catch {
        return false
      }
    })
  }

  state(): SttState {
    return {
      modelReady: this.present(),
      engineReady: !!this.recognizer,
      downloading: this.downloading,
      error: this.lastError
    }
  }

  /**
   * Fetch the model if missing. Every file is written to a temp name, hashed,
   * and only then moved into place — a half-downloaded 225 MB blob must never
   * look like a usable model.
   */
  async ensureModel(onProgress?: (p: SttProgress) => void): Promise<void> {
    if (this.present()) return
    // Share one download between concurrent callers. Two of them would otherwise
    // write the same `.part` file at once and produce an interleaved blob that
    // fails its hash — after a 225 MB wait.
    if (this.downloadJob) return this.downloadJob
    this.downloadJob = this.downloadModel(onProgress).finally(() => {
      this.downloadJob = null
    })
    return this.downloadJob
  }

  private async downloadModel(onProgress?: (p: SttProgress) => void): Promise<void> {
    mkdirSync(this.modelDir(), { recursive: true })
    for (const f of MODEL.files) {
      const dest = this.filePath(f.name)
      if (existsSync(dest) && statSync(dest).size === f.bytes) continue
      const tmp = `${dest}.part`
      try {
        await this.download(f.url, tmp, f.bytes, (received) => {
          this.downloading = { file: f.name, received, total: f.bytes }
          onProgress?.(this.downloading)
        })
        const size = statSync(tmp).size
        if (size !== f.bytes) throw new Error(`${f.name}: получено ${size} байт вместо ${f.bytes}`)
        if (f.sha256) {
          const actual = createHash('sha256').update(await readFile(tmp)).digest('hex')
          if (actual !== f.sha256) throw new Error(`${f.name}: контрольная сумма не сошлась`)
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
    if (hops > 5) return Promise.reject(new Error('слишком много перенаправлений'))
    if (!url.startsWith('https://'))
      return Promise.reject(new Error('источник модели должен быть https'))
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
            reject(new Error('ответ длиннее ожидаемого'))
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
        reject(new Error('таймаут загрузки'))
      })
    })
  }

  /** Build the recognizer once; concurrent callers share one load. */
  private async ensureEngine(): Promise<void> {
    if (this.recognizer) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      if (!this.present()) throw new Error('Модель распознавания не установлена')
      // Required lazily: loading the addon costs memory, and most sessions
      // never dictate anything.
      const sherpa = require('sherpa-onnx-node')
      const config = {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          nemoCtc: { model: this.filePath('model.int8.onnx') },
          tokens: this.filePath('tokens.txt'),
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
    if (!this.recognizer) throw new Error('Распознаватель не готов')
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
