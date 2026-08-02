/**
 * Своя модель распознавания — та, что человек принёс с диска.
 *
 * Встроенный список закрыт намеренно (см. sttModels.ts): скачанный файл уходит
 * в нативный движок, и поле «вставь ссылку» было бы способом выполнить чужой
 * код. Здесь другой порядок: файлы уже лежат на машине, а путь приходит только
 * из системного диалога — тот же жест, что «Открыть файл» в редакторе.
 *
 * Отсюда работа этого модуля: понять, ЧТО именно в папке, и отказаться, если
 * не понял. Догадка обошлась бы дороже отказа — движок собирается минуту и
 * падает невнятной нативной ошибкой.
 */

import type { SttFamily } from './sttModels'

/** Сколько своих моделей помним. Список — удобство, а не хранилище. */
export const CUSTOM_MAX = 8

/**
 * Форма конфигурации каждого семейства: роль → ключ, которого ждёт движок.
 *
 * Таблица одна на всё: по ней и опознают папку, и собирают конфиг. Пока это
 * были три семейства, ветка `if` читалась; на десяти она бы разъехалась с
 * реальностью, и разъезд заметил бы только тот, кто ждал минуту и получил
 * ошибку про отсутствующий файл.
 *
 * Ключи взяты из типов аддона sherpa-onnx (`types.js`, OfflineModelConfig).
 */
export const FAMILY_SHAPE: Record<SttFamily, string[]> = {
  nemoCtc: ['model'],
  senseVoice: ['model'],
  paraformer: ['model'],
  zipformerCtc: ['model'],
  dolphin: ['model'],
  whisper: ['encoder', 'decoder'],
  canary: ['encoder', 'decoder'],
  fireRedAsr: ['encoder', 'decoder'],
  transducer: ['encoder', 'decoder', 'joiner'],
  moonshine: ['preprocessor', 'encoder', 'uncachedDecoder', 'cachedDecoder']
}

export const FAMILIES = Object.keys(FAMILY_SHAPE) as SttFamily[]

/** Своя модель в настройках. `dir` абсолютный: файлы остаются там, где лежат. */
export interface CustomSttModel {
  id: string
  name: string
  /** Может быть пустым: у мультиязычных моделей одного языка нет. */
  lang: string
  family: SttFamily
  dir: string
  /** Роль → имя файла внутри `dir`. Словарь лежит под ключом `tokens`. */
  files: Record<string, string>
  bytes: number
}

/** Файл, увиденный в папке: имя и размер. Содержимое здесь никого не волнует. */
export interface DirEntry {
  name: string
  bytes: number
}

export type IdentifyFail =
  /** Ни манифеста, ни узнаваемого состава — просить манифест. */
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'noTokens' }
  | { ok: false; reason: 'badFamily'; detail: string }
  | { ok: false; reason: 'badFile'; detail: string }
  | { ok: false; reason: 'missing'; detail: string }
  | { ok: false; reason: 'badManifest' }

export type IdentifyOk = {
  ok: true
  family: SttFamily
  files: Record<string, string>
  bytes: number
  /** Из манифеста; пусто — вызывающий подставит имя папки. */
  name: string
  lang: string
}

export type Identified = IdentifyOk | IdentifyFail

/** Имя манифеста, если человек решил объяснить содержимое папки словами. */
export const MANIFEST = 'zarya-model.json'

/** Образец манифеста — его показывает отказ «не понял, что это». */
export const MANIFEST_SAMPLE = JSON.stringify(
  {
    name: 'Whisper small',
    lang: 'RU/EN',
    family: 'whisper',
    files: {
      encoder: 'small-encoder.int8.onnx',
      decoder: 'small-decoder.int8.onnx',
      tokens: 'small-tokens.txt'
    }
  },
  null,
  2
)

const ALLOWED_EXT = ['.onnx', '.txt', '.weights', '.json']

/**
 * Имя файла — именно имя, а не путь.
 *
 * Манифест пишет человек, и `"encoder": "../../.ssh/id_ed25519"` там появится
 * не обязательно со зла — но прочитано будет всерьёз. Поэтому разделители, `..`
 * и абсолютные пути не «нормализуются», а отвергаются: тихая починка чужого
 * ввода — это способ однажды починить его неправильно.
 */
export function safeFileName(name: string): boolean {
  if (!name || name.length > 200) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name === '.' || name === '..') return false
  if (/^[a-zA-Z]:/.test(name)) return false
  if (name.startsWith('.')) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return ALLOWED_EXT.includes(name.slice(dot).toLowerCase())
}

function bytesOf(entries: DirEntry[], files: Record<string, string>): number {
  const size = new Map(entries.map((e) => [e.name.toLowerCase(), e.bytes]))
  return Object.values(files).reduce((s, n) => s + (size.get(n.toLowerCase()) ?? 0), 0)
}

/** Первый файл, чьё имя содержит все куски и не содержит ни одного из лишних. */
function pick(entries: DirEntry[], has: string[], not: string[] = []): string | undefined {
  const found = entries.filter((e) => {
    const n = e.name.toLowerCase()
    if (!n.endsWith('.onnx')) return false
    return has.every((h) => n.includes(h)) && !not.some((x) => n.includes(x))
  })
  // Крупнейший из подходящих: рядом с int8-версией часто лежит полная, и обе
  // рабочие — но выбор «какой попадётся первым» зависел бы от порядка чтения
  // каталога, то есть от файловой системы. Пусть решает размер.
  return found.sort((a, b) => b.bytes - a.bytes)[0]?.name
}

/**
 * Все эти `.onnx` — редакции ОДНОГО файла?
 *
 * В папках sherpa-onnx полная и квантованная модели лежат рядом:
 * `model.onnx` и `model.int8.onnx`, `small-encoder.onnx` и
 * `small-encoder.int8.onnx`. Отличие всегда в суффиксах вроде `.int8` перед
 * расширением, поэтому сравниваются имена без них.
 */
function sameModelFile(onnx: DirEntry[]): boolean {
  const base = (n: string): string =>
    n
      .toLowerCase()
      .replace(/\.onnx$/, '')
      .replace(/[._-](int8|fp16|fp32|quant|q8|q4)$/g, '')
  const first = base(onnx[0].name)
  return onnx.every((e) => base(e.name) === first)
}

/** Словарь: без него не собирается ни одно семейство. */
function tokensOf(entries: DirEntry[]): string | undefined {
  const txt = entries.filter((e) => e.name.toLowerCase().endsWith('tokens.txt'))
  return txt.sort((a, b) => b.bytes - a.bytes)[0]?.name
}

/**
 * Разобрать манифест. Он главнее догадок: человек знает, что принёс.
 */
export function readManifest(raw: string, entries: DirEntry[]): Identified {
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'badManifest' }
  }
  if (!m || typeof m !== 'object') return { ok: false, reason: 'badManifest' }
  const o = m as Record<string, unknown>
  const family = String(o.family ?? '')
  if (!FAMILIES.includes(family as SttFamily))
    return { ok: false, reason: 'badFamily', detail: family || '—' }
  const declared = (o.files ?? {}) as Record<string, unknown>
  const roles = [...FAMILY_SHAPE[family as SttFamily], 'tokens']
  const files: Record<string, string> = {}
  // Имя берётся из ПАПКИ, а не из манифеста. Сверка идёт без учёта регистра —
  // человек пишет по памяти, — но на диск уходит настоящее имя: на Linux
  // «small-encoder.onnx» вместо «Small-Encoder.onnx» проходило проверку и
  // ломалось потом, уже при загрузке движка.
  const present = new Map(entries.map((e) => [e.name.toLowerCase(), e.name]))
  for (const role of roles) {
    const name = declared[role]
    if (typeof name !== 'string' || !name) return { ok: false, reason: 'missing', detail: role }
    if (!safeFileName(name)) return { ok: false, reason: 'badFile', detail: name }
    const real = present.get(name.toLowerCase())
    if (!real) return { ok: false, reason: 'missing', detail: name }
    files[role] = real
  }
  return {
    ok: true,
    family: family as SttFamily,
    files,
    bytes: bytesOf(entries, files),
    name: typeof o.name === 'string' ? o.name.slice(0, 60) : '',
    lang: typeof o.lang === 'string' ? o.lang.slice(0, 12) : ''
  }
}

/**
 * Опознать папку по составу — когда манифеста нет.
 *
 * Имена файлов в репозиториях sherpa-onnx предсказуемы, и большинство моделей
 * узнаются по ним однозначно. Неоднозначен ровно один случай: одинокий
 * `model.onnx` — так выглядят шесть разных семейств сразу. Тогда подсказку даёт
 * имя папки, а если и оно молчит — честный отказ.
 */
export function identifyModel(dirName: string, entries: DirEntry[]): Identified {
  const tokens = tokensOf(entries)
  if (!tokens) return { ok: false, reason: 'noTokens' }
  const bad = entries.find((e) => e.name.toLowerCase().endsWith('.onnx') && !safeFileName(e.name))
  if (bad) return { ok: false, reason: 'badFile', detail: bad.name }

  const hint = dirName.toLowerCase()
  const put = (family: SttFamily, roles: Record<string, string | undefined>): Identified => {
    const files: Record<string, string> = { tokens }
    for (const [role, name] of Object.entries(roles)) {
      if (!name) return { ok: false, reason: 'missing', detail: role }
      files[role] = name
    }
    return { ok: true, family, files, bytes: bytesOf(entries, files), name: '', lang: '' }
  }

  // Moonshine: четыре файла с говорящими именами — ни с чем не спутать.
  const pre = pick(entries, ['preprocess'])
  if (pre)
    return put('moonshine', {
      preprocessor: pre,
      encoder: pick(entries, ['encode'], ['decode', 'preprocess']),
      uncachedDecoder: pick(entries, ['uncached']),
      // «uncached_decode» содержит «cached_decode» целиком: без явного запрета
      // оба декодера оказались бы одним файлом, движок бы собрался, а
      // распознавание выдавало бы мусор — и виновата была бы «плохая модель».
      cachedDecoder: pick(entries, ['cached'], ['uncached'])
    })

  const joiner = pick(entries, ['joiner'])
  const encoder = pick(entries, ['encoder'], ['joiner'])
  const decoder = pick(entries, ['decoder'], ['joiner'])
  if (joiner && encoder && decoder) return put('transducer', { encoder, decoder, joiner })
  if (encoder && decoder) {
    const family: SttFamily = hint.includes('canary')
      ? 'canary'
      : hint.includes('fire-red') || hint.includes('firered')
        ? 'fireRedAsr'
        : 'whisper'
    return put(family, { encoder, decoder })
  }

  // Однофайловые семейства. Файлов при этом может лежать НЕСКОЛЬКО: в
  // канонических папках sherpa-onnx рядом лежат полная и квантованная редакции
  // одного и того же — model.onnx и model.int8.onnx. Пока условие было
  // «ровно один .onnx», такая папка отвергалась как непонятная: то есть
  // мультиязычная sense-voice, ради которой всё и затевалось, не ставилась.
  const onnx = entries.filter((e) => e.name.toLowerCase().endsWith('.onnx'))
  if (onnx.length && sameModelFile(onnx)) {
    // Из редакций берём КРУПНУЮ: она точнее, а место человек уже потратил,
    // скачав папку целиком.
    const single = [...onnx].sort((a, b) => b.bytes - a.bytes)[0].name
    const family: SttFamily | null = hint.includes('sense-voice') || hint.includes('sensevoice')
      ? 'senseVoice'
      : hint.includes('paraformer')
        ? 'paraformer'
        : hint.includes('zipformer')
          ? 'zipformerCtc'
          : hint.includes('dolphin')
            ? 'dolphin'
            : // «ctc» нарочно НЕ считается приметой NeMo: так называются и чужие
              // семейства (telespeech-ctc, wenet-ctc), а часть из них аддон не
              // умеет вовсе. Отдать их под nemoCtc — это не догадка, а неправда.
              hint.includes('nemo') || hint.includes('giga')
              ? 'nemoCtc'
              : null
    // Шесть семейств выглядят одинаково — один файл и словарь. Угадать «скорее
    // всего nemoCtc» значило бы отдать движку модель не той формы, а он на этом
    // не ошибается вежливо: нативный код просто убивает процесс.
    if (!family) return { ok: false, reason: 'unknown' }
    return put(family, { model: single })
  }

  return { ok: false, reason: 'unknown' }
}

/** Уникальный id своей модели: путь и есть её тождество. */
export function customId(dir: string): string {
  const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return `custom:${(h >>> 0).toString(36)}`
}

/**
 * Добавить свою модель в список: та же папка заменяет прежнюю запись (человек
 * обновил файлы), новая встаёт первой, лишние с хвоста уходят.
 */
export function withCustom(
  list: CustomSttModel[],
  model: CustomSttModel,
  max = CUSTOM_MAX
): CustomSttModel[] {
  const rest = list.filter((m) => m.id !== model.id)
  return [model, ...rest].slice(0, Math.max(1, max))
}
