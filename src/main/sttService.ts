import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { tm } from './lang'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { readFile } from 'fs/promises'
import { get } from 'https'
import { basename, join } from 'path'
import { app } from 'electron'
import {
  DEFAULT_STT_MODEL,
  findSttModel,
  pickSttModel,
  sttModelBytes,
  STT_MODELS,
  type SttModelDef
} from '@shared/sttModels'
import {
  customId,
  FAMILY_SHAPE,
  identifyModel,
  MANIFEST,
  readManifest,
  type CustomSttModel,
  type DirEntry,
  type Identified
} from '@shared/sttCustom'

/** Сколько ждём пробную сборку модели: крупные грузятся десятки секунд. */
const PROBE_TIMEOUT_MS = 120_000

/**
 * Оставить от нативного вывода то, что человеку пригодится.
 *
 * sherpa-onnx печатает строку вида
 * `D:\a\sherpa-onnx\...\offline-sense-voice-model.cc:Init:118 'lfr_window_size'
 * does not exist in the metadata`: сначала путь к СВОЕМУ исходнику на машине
 * сборщика, и только потом — чего не хватило в модели. Показывать это целиком
 * значит начать объяснение с чужого пути, в котором человеку ничего не сделать;
 * нужен хвост — именно он называет настоящий формат папки.
 */
export function firstLine(s: string): string {
  const lines = s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  const m = last.match(/\.(?:cc|cu|cpp|h):[A-Za-z_]\w*:\d+\s+(.*)$/)
  return (m ? m[1] : last).slice(0, 300)
}

/** Что вообще может быть частью модели: остальное даже не взвешивается. */
const MODEL_EXT = /\.(onnx|txt|weights|json)$/i
/** Потолок на число рассматриваемых файлов — защита от «выбрал не ту папку». */
const MAX_MODEL_FILES = 200

/** Размер файла, который может исчезнуть между чтением каталога и статом. */
function safeSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

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
  /** Ключ подписи у встроенных; у своей пуст — имя дал человек. */
  labelKey: string
  lang: string
  license: string
  noteKey: string
  bytes: number
  installed: boolean
  legacy: boolean
  /** Своя модель: принесена с диска, а не скачана Зарёй. */
  custom?: boolean
  /** Имя своей модели (готовая строка, не ключ) и папка, где она лежит. */
  name?: string
  dir?: string
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

/**
 * Модель в том виде, в котором её грузит движок: где лежит и какой файл за
 * какую роль отвечает. Встроенные и свои различаются происхождением, но грузятся
 * одинаково — иначе своя была бы гражданином второго сорта, а человек ждёт от
 * неё того же, что от встроенной.
 */
interface Runnable {
  id: string
  family: SttModelDef['family']
  /** Абсолютный путь к папке с файлами. */
  dir: string
  /** Роль → имя файла внутри dir. */
  roles: Record<string, string>
  legacy: boolean
  custom: boolean
}

export class SttService {
  private recognizer: Recognizer | null = null
  /** Какая модель выбрана человеком; задаётся из настроек при старте. */
  private selectedId = ''
  /** Свои модели из настроек: путь, семейство и роли файлов. */
  private customs: CustomSttModel[] = []
  /**
   * Какие свои модели уже пережили пробную сборку — по подписи файлов на диске.
   * Проверка стоит секунд и сотен мегабайт, повторять её на каждую диктовку
   * незачем; изменились файлы — изменилась подпись, и проверка будет заново.
   */
  private probed = new Map<string, boolean>()
  /** Какая модель сейчас в движке: id и подпись её файлов на диске. */
  private loadedKey = ''
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

  /** Встроенная модель как объект загрузки: роли уже описаны в реестре. */
  private toRunnable(m: SttModelDef): Runnable {
    const roles: Record<string, string> = {}
    for (const f of m.files) roles[f.role] = f.name
    return {
      id: m.id,
      family: m.family,
      dir: this.dirOf(m),
      roles,
      legacy: !!m.legacy,
      custom: false
    }
  }

  private customRunnable(c: CustomSttModel): Runnable {
    return { id: c.id, family: c.family, dir: c.dir, roles: c.files, legacy: false, custom: true }
  }

  /** Все модели разом: встроенные, затем свои. */
  private runnables(): Runnable[] {
    return [
      ...STT_MODELS.map((m) => this.toRunnable(m)),
      ...this.customs.map((c) => this.customRunnable(c))
    ]
  }

  /**
   * Своя модель на месте, если все её файлы читаются. Размеры не сверяются:
   * человек мог принести другую редакцию тех же весов, и требовать байт в байт
   * значило бы объявлять его модель сломанной без причины.
   */
  private customInstalled(c: CustomSttModel): boolean {
    return Object.values(c.files).every((n) => {
      try {
        return statSync(join(c.dir, n)).isFile()
      } catch {
        return false
      }
    })
  }

  private runnableInstalled(r: Runnable): boolean {
    if (r.custom) {
      const c = this.customs.find((x) => x.id === r.id)
      return !!c && this.customInstalled(c)
    }
    const m = findSttModel(r.id)
    return !!m && this.installed(m)
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

  /** Что реально грузить с учётом того, что скачано и что принесено. */
  private active(): Runnable | null {
    return pickSttModel(this.wantedId(), this.runnables(), (r) => this.runnableInstalled(r))
  }

  /** Выбор модели из настроек. Смена выгружает движок: он держит прежнюю в памяти. */
  select(id: string): void {
    if (id === this.selectedId) return
    this.selectedId = id
    this.recognizer = null
    this.loadedKey = ''
  }

  /**
   * Свои модели из настроек. Если состав изменился, движок выгружается: он
   * держит в памяти ту, что грузил, и убранная из списка продолжала бы
   * распознавать — интерфейс говорил бы одно, а работала бы другая.
   */
  setCustom(list: CustomSttModel[]): void {
    // Сравнивается и состав файлов: та же папка, переопознанная после того как
    // человек обновил в ней веса, — это ДРУГАЯ модель, а движок продолжал бы
    // говорить голосом прежней, потому что она уже загружена в память.
    const key = (c?: CustomSttModel): string =>
      c ? `${c.id}|${c.dir}|${c.family}|${JSON.stringify(c.files)}` : ''
    const same =
      list.length === this.customs.length &&
      list.every((c, i) => key(c) === key(this.customs[i]))
    this.customs = list
    if (!same) {
      this.recognizer = null
      this.loadedKey = ''
    }
  }

  state(): SttState {
    const active = this.active()
    return {
      modelReady: !!active,
      legacyModel: !!active?.legacy,
      activeModelId: active?.id ?? null,
      models: [
        ...STT_MODELS.filter((m) => !m.legacy || this.installed(m)).map((m) => ({
          id: m.id,
          labelKey: m.labelKey,
          lang: m.lang,
          license: m.license,
          noteKey: m.noteKey,
          bytes: sttModelBytes(m),
          installed: this.installed(m),
          legacy: !!m.legacy
        })),
        // Свои идут после встроенных: их принесли позже, и список не должен
        // перетасовываться оттого, что человек добавил ещё одну.
        ...this.customs.map((c) => ({
          id: c.id,
          labelKey: '',
          lang: c.lang,
          license: '',
          noteKey: '',
          bytes: c.bytes,
          installed: this.customInstalled(c),
          legacy: false,
          custom: true,
          name: c.name,
          dir: c.dir
        }))
      ],
      engineReady: !!this.recognizer,
      downloading: this.downloading,
      error: this.lastError
    }
  }

  /**
   * Разобрать папку, которую человек выбрал: что это за модель, и — главное —
   * заводится ли она вообще.
   *
   * Ничего не копируется и никуда не записывается: файлы остаются там, где
   * лежат, решение сохранить запись принимает вызывающий. Пробная сборка идёт
   * ЗДЕСЬ, а не при первой диктовке: узнать «эта папка не собирается» лучше
   * сразу после выбора, пока человек ещё помнит, что он выбрал.
   */
  async identifyDir(
    dir: string
  ): Promise<{ ok: true; model: CustomSttModel } | { ok: false; error: string }> {
    let all: string[]
    try {
      all = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && MODEL_EXT.test(e.name))
        .map((e) => e.name)
    } catch {
      return { ok: false, error: tm('main.stt.custom.dirUnreadable') }
    }
    // Манифест ищется ДО отсечки по количеству и по настоящему имени файла.
    // Он начинается с «z», и в папке с сотнями файлов алфавитный порядок
    // выбрасывал его за предел — Заря игнорировала прямо написанное человеком и
    // уходила гадать. Регистр тоже настоящий: на Linux файл «Zarya-Model.json»
    // находился поиском, но читался по имени в нижнем регистре и не открывался.
    const manifestName = all.find((n) => n.toLowerCase() === MANIFEST)
    const entries: DirEntry[] = all
      .slice(0, MAX_MODEL_FILES)
      .map((n) => ({ name: n, bytes: safeSize(join(dir, n)) }))

    let res: Identified
    if (manifestName) {
      try {
        res = readManifest(readFileSync(join(dir, manifestName), 'utf8'), entries)
      } catch {
        res = { ok: false, reason: 'badManifest' }
      }
    } else {
      res = identifyModel(basename(dir) || dir, entries)
    }
    if (!res.ok) {
      const detail = 'detail' in res ? res.detail : ''
      return { ok: false, error: tm(`main.stt.custom.${res.reason}`, { detail }) }
    }

    const model: CustomSttModel = {
      id: customId(dir),
      // Папка в корне диска имени не имеет: basename('E:\\') — пустая строка, и
      // строка в списке осталась бы без заголовка, а тост сказал бы «Модель
      // добавлена: ». Тогда именем становится сам путь.
      name: res.name || basename(dir) || dir,
      lang: res.lang,
      family: res.family,
      dir,
      files: res.files,
      bytes: res.bytes
    }

    // Единственная честная проверка «та ли это модель» — попытка её собрать.
    // Формат ONNX сам о семействе не говорит, а ошибка в семействе стоит не
    // «плохого распознавания», а мгновенной смерти приложения (см. probe).
    try {
      await this.probe(this.customRunnable(model), this.buildConfig(this.customRunnable(model)))
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, model }
  }

  /** Убрать скачанную модель с диска — она весит сотни мегабайт. */
  async removeModel(id: string): Promise<{ ok: boolean; error?: string }> {
    // Свою модель Заря не удаляет: эти файлы принесли не она. Из списка её
    // убирают настройки, папка остаётся нетронутой.
    if (this.customs.some((c) => c.id === id))
      return { ok: false, error: tm('main.stt.custom.notOurs') }
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

  /**
   * Конфигурация движка для модели.
   *
   * У каждого семейства своя форма и свой набор файлов: CTC — один файл,
   * transducer — три, moonshine — четыре. Формы собраны в одну таблицу
   * (FAMILY_SHAPE), она же служит опознанию своих моделей: две копии этого
   * знания разошлись бы молча. Ключи проверены в бинарнике аддона, а не взяты
   * из документации.
   */
  private buildConfig(m: Runnable): Record<string, unknown> {
    const f = (n: string): string => join(m.dir, n)
    const shape: Record<string, string> = {}
    for (const role of FAMILY_SHAPE[m.family]) {
      const name = m.roles[role]
      if (!name) throw new Error(tm('main.stt.custom.missing', { detail: role }))
      shape[role] = f(name)
    }
    const tokens = m.roles.tokens
    if (!tokens) throw new Error(tm('main.stt.custom.noTokens', { detail: '' }))
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        [m.family]: shape,
        tokens: f(tokens),
        numThreads: Math.max(1, Math.min(4, (require('os').cpus()?.length ?? 2) - 1)),
        provider: 'cpu',
        debug: false
      }
    }
  }

  /**
   * Подпись модели на диске: путь, имена, размеры и время правки файлов.
   * Проверять заново стоит только тогда, когда файлы изменились — сама проверка
   * это полная загрузка модели, то есть секунды и сотни мегабайт памяти.
   */
  private signature(m: Runnable): string {
    const parts = Object.entries(m.roles).map(([role, name]) => {
      try {
        const st = statSync(join(m.dir, name))
        return `${role}:${name}:${st.size}:${Math.round(st.mtimeMs)}`
      } catch {
        return `${role}:${name}:нет`
      }
    })
    return `${m.dir}|${m.family}|${parts.sort().join('|')}`
  }

  /**
   * Попробовать собрать движок в ОТДЕЛЬНОМ процессе.
   *
   * Единственный способ пережить чужую модель. sherpa-onnx, получив файл не той
   * формы (модель senseVoice, объявленная как whisper, — обычная опечатка в
   * манифесте), не возвращает ошибку: нативная библиотека пишет строку в stderr
   * и вызывает exit(-1) прямо из рабочего потока. В главном процессе это смерть
   * приложения: панели, терминалы, агенты и несохранённое состояние исчезают
   * молча, а выбор модели остаётся в настройках — и следующий запуск умирает
   * так же. Проверять содержимое ONNX самим невозможно, поэтому проверка — это
   * попытка запуска там, где падение никому не вредит.
   *
   * Дочерний процесс — та же Заря в режиме Node (ELECTRON_RUN_AS_NODE): свой
   * `node` рядом не гарантирован, а нативный аддон собран под этот ABI.
   */
  private async probe(m: Runnable, config: Record<string, unknown>): Promise<void> {
    const sig = this.signature(m)
    if (this.probed.get(sig)) return
    const code = [
      'const sherpa = require(process.argv[1]);',
      'const cfg = JSON.parse(process.argv[2]);',
      'sherpa.OfflineRecognizer.createAsync(cfg).then(',
      '  () => process.exit(0),',
      '  (e) => { process.stderr.write(String((e && e.message) || e)); process.exit(3); }',
      ');'
    ].join('\n')
    const modPath = require.resolve('sherpa-onnx-node')
    const res = await new Promise<{ code: number | null; err: string }>((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(process.execPath, ['-e', code, modPath, JSON.stringify(config)], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        })
      } catch (e) {
        resolve({ code: -100, err: e instanceof Error ? e.message : String(e) })
        return
      }
      let err = ''
      child.stderr?.on('data', (b: Buffer) => {
        // Нативная строка бывает многословной; человеку нужен смысл, не поток.
        if (err.length < 2000) err += b.toString()
      })
      // Крупные модели грузятся десятки секунд; вечно ждать всё же нельзя.
      const timer = setTimeout(() => {
        child.kill()
        resolve({ code: -101, err: '' })
      }, PROBE_TIMEOUT_MS)
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: -100, err: e.message })
      })
      child.on('exit', (c) => {
        clearTimeout(timer)
        resolve({ code: c, err })
      })
    })

    if (res.code === 0) {
      this.probed.set(sig, true)
      return
    }
    if (res.code === -101) throw new Error(tm('main.stt.custom.probeTimeout'))
    if (res.code === -100) throw new Error(tm('main.stt.custom.probeNoRun', { detail: res.err }))
    // Движок отказался сам — показываем его слова: они называют недостающие
    // метаданные, по которым видно, какое семейство на самом деле в папке.
    const detail = firstLine(res.err) || String(res.code)
    throw new Error(tm('main.stt.custom.probeFailed', { family: m.family, detail }))
  }

  /** Build the recognizer once; concurrent callers share one load. */
  private async ensureEngine(): Promise<void> {
    // Что грузить — решаем ДО того, как обрадоваться готовому движку. Раньше
    // условие было «движок есть — работаем», и он переживал события, после
    // которых говорил уже не за ту модель: своя модель лежала на внешнем диске,
    // при старте её не было — собрался GigaAM; человек воткнул диск, в
    // настройках его модель снова «активна», а распознавал по-прежнему GigaAM.
    // Интерфейс называл одну, работала другая.
    const want = this.active()
    const key = want ? `${want.id}|${this.signature(want)}` : ''
    if (this.recognizer && this.loadedKey === key) return
    if (this.recognizer) this.recognizer = null
    if (this.loading) return this.loading
    this.loading = (async () => {
      const m = this.active()
      if (!m) throw new Error(tm('main.stt.notInstalled'))
      const config = this.buildConfig(m)
      // Своя модель проверяется в ОТДЕЛЬНОМ процессе, прежде чем попасть сюда.
      // Причина жёсткая: движок, получив ONNX не той формы, не бросает ошибку —
      // он зовёт exit(-1) прямо из нативного потока. Промис не отвергается,
      // try/catch бессилен, и Заря исчезает целиком вместе со всеми панелями,
      // терминалами и агентами. Без единого слова о причине.
      if (m.custom) await this.probe(m, config)
      // Required lazily: loading the addon costs memory, and most sessions
      // never dictate anything.
      const sherpa = require('sherpa-onnx-node')
      this.recognizer = await sherpa.OfflineRecognizer.createAsync(config)
      // Запоминаем ИМЕННО ту модель, что загружена: по ней потом видно, не
      // разошёлся ли движок с тем, что показывают настройки.
      this.loadedKey = `${m.id}|${this.signature(m)}`
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
    this.loadedKey = ''
  }
}
