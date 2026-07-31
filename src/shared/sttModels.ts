/**
 * Реестр моделей распознавания речи.
 *
 * Список ЗАКРЫТЫЙ и живёт в коде. Настраиваемый адрес модели был бы примитивом
 * «скачай что угодно откуда угодно», а скачанное мы отдаём нативному движку —
 * то есть это был бы способ выполнить чужой код. Поэтому добавление модели —
 * правка исходника, а не поле ввода в настройках.
 *
 * У каждого семейства свой набор файлов и своя форма конфигурации движка
 * (ключи проверены прямо в бинарнике аддона sherpa-onnx 1.13.4): CTC — один
 * файл, transducer — три, moonshine — четыре. Поэтому «добавить модель» это не
 * всегда «поменять ссылку».
 */

export type SttFamily = 'nemoCtc' | 'transducer' | 'moonshine'

export interface SttModelFile {
  name: string
  /** Пусто у моделей прошлых версий: их не скачивают, их только опознают. */
  url?: string
  bytes: number
  /** null — файл слишком мал для LFS-хеша у источника, сверяется по размеру. */
  sha256?: string | null
}

export interface SttModelDef {
  id: string
  /** Ключ подписи: сам файл общий, язык подставляет тот, кто рисует. */
  labelKey: string
  /** Язык в виде «RU» / «EN» — для строки выбора. */
  lang: string
  family: SttFamily
  license: string
  /** Каталог внутри userData/models. */
  dir: string
  files: SttModelFile[]
  /** Ключ короткого пояснения: чем эта модель отличается от соседей. */
  noteKey: string
  /** Прошлая модель: остаётся рабочей, но не предлагается к скачиванию. */
  legacy?: boolean
}

export const STT_MODELS: SttModelDef[] = [
  {
    id: 'gigaam-v3-ru-punct',
    labelKey: 'stt.gigaRu',
    lang: 'RU',
    family: 'nemoCtc',
    license: 'MIT',
    dir: 'gigaam-v3-ru-punct',
    noteKey: 'stt.gigaRuNote',
    files: [
      {
        name: 'model.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16/resolve/main/model.int8.onnx',
        bytes: 224893661,
        sha256: 'd5fea8df94263c285e54b21e5774b707c707192d3bdbeffd7b1eb07fb6743b35'
      },
      {
        name: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16/resolve/main/tokens.txt',
        bytes: 2007,
        sha256: null
      }
    ]
  },
  {
    id: 'gigaam-v3-ru-rnnt',
    labelKey: 'stt.gigaRnnt',
    lang: 'RU',
    family: 'transducer',
    license: 'MIT',
    dir: 'gigaam-v3-ru-rnnt',
    noteKey: 'stt.gigaRnntNote',
    files: [
      {
        name: 'encoder.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16/resolve/main/encoder.int8.onnx',
        bytes: 224570820,
        sha256: '369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf'
      },
      {
        name: 'decoder.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16/resolve/main/decoder.onnx',
        bytes: 4600132,
        sha256: '38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4'
      },
      {
        name: 'joiner.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16/resolve/main/joiner.onnx',
        bytes: 2712896,
        sha256: '602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c'
      },
      {
        name: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16/resolve/main/tokens.txt',
        bytes: 13354,
        sha256: null
      }
    ]
  },
  {
    id: 'moonshine-tiny-en',
    labelKey: 'stt.moonshine',
    lang: 'EN',
    family: 'moonshine',
    license: 'MIT',
    dir: 'moonshine-tiny-en',
    // Whisper добивает любой вход нулями до 30 секунд, поэтому фраза на три
    // секунды стоит столько же, сколько на тридцать. Moonshine считает
    // пропорционально длине — для диктовки короткими фразами это структурное
    // преимущество, а не разница в весах.
    noteKey: 'stt.moonshineNote',
    files: [
      {
        name: 'preprocess.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/preprocess.onnx',
        bytes: 6800738,
        sha256: 'f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e'
      },
      {
        name: 'encode.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/encode.int8.onnx',
        bytes: 18249187,
        sha256: '8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb'
      },
      {
        name: 'uncached_decode.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/uncached_decode.int8.onnx',
        bytes: 53216096,
        sha256: '216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41'
      },
      {
        name: 'cached_decode.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/cached_decode.int8.onnx',
        bytes: 45264830,
        sha256: '2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6'
      },
      {
        name: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/tokens.txt',
        bytes: 436688,
        sha256: null
      }
    ]
  },
  {
    // Модель прежних версий Зари. Скачать её больше нельзя, но если она уже
    // лежит на диске — диктовка работает: заставлять человека качать 225 МБ
    // заново из-за обновления приложения неправильно.
    id: 'gigaam-v3-ru-legacy',
    labelKey: 'stt.gigaOld',
    lang: 'RU',
    family: 'nemoCtc',
    license: 'MIT',
    dir: 'gigaam-v3-ru',
    noteKey: 'stt.gigaOldNote',
    legacy: true,
    files: [
      { name: 'model.int8.onnx', bytes: 224721476 },
      { name: 'tokens.txt', bytes: 196 }
    ]
  }
]

export const DEFAULT_STT_MODEL = 'gigaam-v3-ru-punct'

export function findSttModel(id: string): SttModelDef | undefined {
  return STT_MODELS.find((m) => m.id === id)
}

/** Сколько весит модель целиком. */
export function sttModelBytes(m: SttModelDef): number {
  return m.files.reduce((s, f) => s + f.bytes, 0)
}

/** Модели, которые можно предложить скачать (прошлые версии — нельзя). */
export function downloadableModels(): SttModelDef[] {
  return STT_MODELS.filter((m) => !m.legacy)
}

/**
 * Какую модель грузить: выбранную, если она скачана; иначе любую скачанную —
 * иначе выбор в настройках молча ломал бы диктовку до конца скачивания.
 * Прошлые версии рассматриваются последними.
 */
export function resolveSttModel(
  wantedId: string,
  installed: (m: SttModelDef) => boolean
): SttModelDef | null {
  const wanted = findSttModel(wantedId)
  if (wanted && installed(wanted)) return wanted
  const fresh = STT_MODELS.find((m) => !m.legacy && installed(m))
  if (fresh) return fresh
  return STT_MODELS.find((m) => m.legacy && installed(m)) ?? null
}
