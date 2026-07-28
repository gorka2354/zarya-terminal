import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STT_MODEL,
  downloadableModels,
  findSttModel,
  resolveSttModel,
  sttModelBytes,
  STT_MODELS,
  type SttModelDef
} from '@shared/sttModels'

/**
 * Реестр моделей распознавания. Список закрытый и живёт в коде: настраиваемый
 * адрес был бы примитивом «скачай что угодно откуда угодно», а скачанное мы
 * отдаём нативному движку — то есть способом выполнить чужой код.
 */
const installedOnly =
  (...ids: string[]) =>
  (m: SttModelDef): boolean =>
    ids.includes(m.id)

describe('целостность реестра', () => {
  it('у каждой модели есть всё, что нужно для показа и загрузки', () => {
    for (const m of STT_MODELS) {
      expect(m.id, 'id').toBeTruthy()
      expect(m.label, `label у ${m.id}`).toBeTruthy()
      expect(m.note, `note у ${m.id}`).toBeTruthy()
      expect(m.license, `лицензия у ${m.id}`).toBeTruthy()
      expect(m.files.length, `файлы у ${m.id}`).toBeGreaterThan(0)
      expect(m.files.some((f) => f.name === 'tokens.txt'), `tokens у ${m.id}`).toBe(true)
    }
  })

  it('идентификаторы и каталоги не пересекаются', () => {
    // Совпадение каталогов означало бы, что одна модель затирает файлы другой.
    expect(new Set(STT_MODELS.map((m) => m.id)).size).toBe(STT_MODELS.length)
    expect(new Set(STT_MODELS.map((m) => m.dir)).size).toBe(STT_MODELS.length)
  })

  it('источники — только https и только HuggingFace', () => {
    for (const m of STT_MODELS) {
      for (const f of m.files) {
        if (!f.url) continue
        expect(f.url.startsWith('https://huggingface.co/'), `${m.id}/${f.name}`).toBe(true)
      }
    }
  })

  it('у скачиваемых файлов есть размер, у крупных — контрольная сумма', () => {
    for (const m of downloadableModels()) {
      for (const f of m.files) {
        expect(f.url, `${m.id}/${f.name}`).toBeTruthy()
        expect(f.bytes, `${m.id}/${f.name}`).toBeGreaterThan(0)
        // Мелкие файлы у источника не хешируются, они проверяются по размеру.
        if (f.bytes > 1_000_000) expect(f.sha256, `${m.id}/${f.name}`).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })

  it('набор файлов соответствует семейству', () => {
    // Ошибка здесь означала бы, что движок получит конфиг без нужного файла и
    // упадёт уже во время диктовки.
    for (const m of STT_MODELS) {
      const names = m.files.map((f) => f.name)
      if (m.family === 'nemoCtc') expect(names).toContain('model.int8.onnx')
      if (m.family === 'transducer') {
        expect(names).toEqual(
          expect.arrayContaining(['encoder.int8.onnx', 'decoder.onnx', 'joiner.onnx'])
        )
      }
      if (m.family === 'moonshine') {
        expect(names).toEqual(
          expect.arrayContaining([
            'preprocess.onnx',
            'encode.int8.onnx',
            'uncached_decode.int8.onnx',
            'cached_decode.int8.onnx'
          ])
        )
      }
    }
  })

  it('модель по умолчанию существует и скачиваема', () => {
    const d = findSttModel(DEFAULT_STT_MODEL)
    expect(d).toBeDefined()
    expect(d?.legacy).toBeFalsy()
  })

  it('прошлая модель есть в реестре, но не предлагается к скачиванию', () => {
    const legacy = STT_MODELS.filter((m) => m.legacy)
    expect(legacy.length).toBeGreaterThan(0)
    expect(downloadableModels().some((m) => m.legacy)).toBe(false)
    // У неё нет источников: скачать её больше нельзя, только опознать.
    for (const m of legacy) for (const f of m.files) expect(f.url).toBeUndefined()
  })
})

describe('sttModelBytes', () => {
  it('складывает все файлы, а не только основной', () => {
    const moonshine = findSttModel('moonshine-tiny-en')!
    expect(sttModelBytes(moonshine)).toBe(moonshine.files.reduce((s, f) => s + f.bytes, 0))
    // Пять файлов: считать по одному было бы враньём в интерфейсе про вес.
    expect(moonshine.files.length).toBe(5)
  })
})

describe('resolveSttModel', () => {
  it('берёт выбранную, когда она скачана', () => {
    const r = resolveSttModel('moonshine-tiny-en', installedOnly('moonshine-tiny-en'))
    expect(r?.id).toBe('moonshine-tiny-en')
  })

  it('выбранная не скачана — берёт любую скачанную, а не молчит', () => {
    // Иначе выбор в настройках ломал бы диктовку до конца скачивания.
    const r = resolveSttModel('moonshine-tiny-en', installedOnly('gigaam-v3-ru-punct'))
    expect(r?.id).toBe('gigaam-v3-ru-punct')
  })

  it('прошлая версия — последняя в очереди, но лучше чем ничего', () => {
    const r = resolveSttModel('moonshine-tiny-en', installedOnly('gigaam-v3-ru-legacy'))
    expect(r?.id).toBe('gigaam-v3-ru-legacy')
  })

  it('свежая модель предпочитается прошлой', () => {
    const r = resolveSttModel('', installedOnly('gigaam-v3-ru-legacy', 'gigaam-v3-ru-punct'))
    expect(r?.id).toBe('gigaam-v3-ru-punct')
  })

  it('ничего не скачано — null, а не догадка', () => {
    expect(resolveSttModel('gigaam-v3-ru-punct', () => false)).toBeNull()
  })

  it('неизвестный id не роняет выбор', () => {
    const r = resolveSttModel('нет-такой-модели', installedOnly('gigaam-v3-ru-punct'))
    expect(r?.id).toBe('gigaam-v3-ru-punct')
  })
})
