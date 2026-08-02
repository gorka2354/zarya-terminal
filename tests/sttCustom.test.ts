import { describe, expect, it } from 'vitest'
import {
  CUSTOM_MAX,
  customId,
  FAMILIES,
  FAMILY_SHAPE,
  identifyModel,
  MANIFEST_SAMPLE,
  readManifest,
  safeFileName,
  withCustom,
  type CustomSttModel,
  type DirEntry
} from '@shared/sttCustom'
import { STT_MODELS } from '@shared/sttModels'

/**
 * Своя модель распознавания — папка, которую человек выбрал сам.
 *
 * Проверяется ровно то, ради чего этот модуль существует: понять, что в папке,
 * и ОТКАЗАТЬСЯ, если не понял. Догадка тут дороже отказа — движок собирается
 * минуту и падает нативной ошибкой, по которой нечего чинить.
 */
const f = (name: string, bytes = 1000): DirEntry => ({ name, bytes })

describe('safeFileName', () => {
  it('обычное имя файла модели проходит', () => {
    expect(safeFileName('model.int8.onnx')).toBe(true)
    expect(safeFileName('small-encoder.int8.onnx')).toBe(true)
    expect(safeFileName('tokens.txt')).toBe(true)
    expect(safeFileName('turbo-encoder.weights')).toBe(true)
  })

  it('путь — не имя: разделители, «..» и абсолютные отвергаются', () => {
    // Манифест пишет человек, и «../../.ssh/id_ed25519» там появится не
    // обязательно со зла — но прочитано будет всерьёз.
    expect(safeFileName('../secrets.onnx')).toBe(false)
    expect(safeFileName('..\\secrets.onnx')).toBe(false)
    expect(safeFileName('sub/model.onnx')).toBe(false)
    expect(safeFileName('C:\\Windows\\model.onnx')).toBe(false)
    expect(safeFileName('/etc/passwd')).toBe(false)
    expect(safeFileName('..')).toBe(false)
  })

  it('чужие расширения и скрытые файлы не проходят', () => {
    expect(safeFileName('model.exe')).toBe(false)
    expect(safeFileName('model.dll')).toBe(false)
    expect(safeFileName('run.sh')).toBe(false)
    expect(safeFileName('.env')).toBe(false)
    expect(safeFileName('noext')).toBe(false)
    expect(safeFileName('')).toBe(false)
    expect(safeFileName(`${'a'.repeat(300)}.onnx`)).toBe(false)
  })
})

describe('таблица форм', () => {
  it('у каждого семейства описаны роли', () => {
    for (const fam of FAMILIES) expect(FAMILY_SHAPE[fam].length, fam).toBeGreaterThan(0)
  })

  it('встроенные модели описывают ровно те роли, которых ждёт движок', () => {
    // Реестр и сборка конфигурации связаны одной таблицей. Разошлись бы они
    // молча: человек ждёт минуту и получает нативную ошибку про файл.
    for (const m of STT_MODELS) {
      const roles = m.files.map((x) => x.role)
      for (const need of FAMILY_SHAPE[m.family]) expect(roles, `${m.id}/${need}`).toContain(need)
      expect(roles, `${m.id}/tokens`).toContain('tokens')
      // Одно имя на роль: два файла с ролью 'model' означали бы, что движок
      // получит какой-то из них по случайности порядка в массиве.
      expect(new Set(roles).size, `${m.id}: роли не повторяются`).toBe(roles.length)
    }
  })
})

describe('опознание папки', () => {
  it('moonshine — по четырём говорящим именам', () => {
    const r = identifyModel('sherpa-onnx-moonshine-tiny-en-int8', [
      f('preprocess.onnx'),
      f('encode.int8.onnx'),
      f('uncached_decode.int8.onnx'),
      f('cached_decode.int8.onnx'),
      f('tokens.txt')
    ])
    expect(r.ok && r.family).toBe('moonshine')
    expect(r.ok && r.files.preprocessor).toBe('preprocess.onnx')
    expect(r.ok && r.files.uncachedDecoder).toBe('uncached_decode.int8.onnx')
    expect(r.ok && r.files.cachedDecoder).toBe('cached_decode.int8.onnx')
  })

  it('transducer — когда есть joiner', () => {
    const r = identifyModel('any-folder', [
      f('encoder.int8.onnx'),
      f('decoder.onnx'),
      f('joiner.onnx'),
      f('tokens.txt')
    ])
    expect(r.ok && r.family).toBe('transducer')
  })

  it('encoder + decoder без joiner — whisper', () => {
    const r = identifyModel('sherpa-onnx-whisper-small', [
      f('small-encoder.int8.onnx'),
      f('small-decoder.int8.onnx'),
      f('small-tokens.txt')
    ])
    expect(r.ok && r.family).toBe('whisper')
    expect(r.ok && r.files.tokens).toBe('small-tokens.txt')
  })

  it('имя папки различает семейства с одинаковым составом файлов', () => {
    const two = [f('encoder.onnx'), f('decoder.onnx'), f('tokens.txt')]
    expect(identifyModel('sherpa-onnx-canary-180m', two).ok && 'canary').toBe('canary')
    const r = identifyModel('sherpa-onnx-fire-red-asr', two)
    expect(r.ok && r.family).toBe('fireRedAsr')
  })

  it('одинокий model.onnx опознаётся по имени папки', () => {
    const one = [f('model.int8.onnx'), f('tokens.txt')]
    expect((identifyModel('sherpa-onnx-sense-voice-zh', one) as { family: string }).family).toBe(
      'senseVoice'
    )
    expect((identifyModel('sherpa-onnx-paraformer-zh', one) as { family: string }).family).toBe(
      'paraformer'
    )
    expect((identifyModel('sherpa-onnx-nemo-ctc-giga', one) as { family: string }).family).toBe(
      'nemoCtc'
    )
  })

  it('одинокий model.onnx в безымянной папке — отказ, а не догадка', () => {
    // Так выглядят шесть разных семейств. Угаданное «скорее всего nemoCtc»
    // собралось бы и выдавало мусор — виновата была бы «плохая модель».
    const r = identifyModel('моя-модель', [f('model.onnx'), f('tokens.txt')])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('unknown')
  })

  it('без словаря — отказ: движок без tokens не соберётся', () => {
    const r = identifyModel('sherpa-onnx-whisper-small', [f('encoder.onnx'), f('decoder.onnx')])
    expect(!r.ok && r.reason).toBe('noTokens')
  })

  it('вес считается по всем файлам роли, а не по одному', () => {
    const r = identifyModel('sherpa-onnx-whisper-small', [
      f('encoder.onnx', 112_000_000),
      f('decoder.onnx', 262_000_000),
      f('tokens.txt', 800_000),
      // Посторонний файл в папке в вес не идёт: движок его не грузит.
      f('README.md', 5000)
    ])
    expect(r.ok && r.bytes).toBe(374_800_000)
  })

  it('из двух редакций одного файла берётся крупная, а не случайная', () => {
    // Рядом с int8 часто лежит полная модель, и обе рабочие. Выбор «какой
    // попадётся первым» зависел бы от порядка чтения каталога.
    const r = identifyModel('sherpa-onnx-whisper-small', [
      f('small-encoder.int8.onnx', 112_000_000),
      f('small-encoder.onnx', 409_000_000),
      f('small-decoder.int8.onnx', 262_000_000),
      f('tokens.txt', 800_000)
    ])
    expect(r.ok && r.files.encoder).toBe('small-encoder.onnx')
  })
})

describe('манифест', () => {
  const entries = [f('enc.onnx'), f('dec.onnx'), f('tokens.txt')]
  const manifest = (o: unknown): string => JSON.stringify(o)

  it('образец из настроек разбирается — он не должен быть красивой ложью', () => {
    const sample = JSON.parse(MANIFEST_SAMPLE) as { files: Record<string, string> }
    const names = Object.values(sample.files).map((n) => f(n))
    const r = readManifest(MANIFEST_SAMPLE, names)
    expect(r.ok).toBe(true)
  })

  it('человек назвал семейство и файлы — берётся его слово', () => {
    const r = readManifest(
      manifest({
        name: 'Моя модель',
        lang: 'RU/EN',
        family: 'whisper',
        files: { encoder: 'enc.onnx', decoder: 'dec.onnx', tokens: 'tokens.txt' }
      }),
      entries
    )
    expect(r.ok && r.family).toBe('whisper')
    expect(r.ok && r.name).toBe('Моя модель')
    expect(r.ok && r.lang).toBe('RU/EN')
  })

  it('манифест не уводит чтение наружу', () => {
    const r = readManifest(
      manifest({
        family: 'whisper',
        files: { encoder: '../../../.ssh/id_ed25519', decoder: 'dec.onnx', tokens: 'tokens.txt' }
      }),
      entries
    )
    expect(!r.ok && r.reason).toBe('badFile')
  })

  it('файл, которого в папке нет, — отказ до попытки загрузки', () => {
    const r = readManifest(
      manifest({
        family: 'whisper',
        files: { encoder: 'enc.onnx', decoder: 'нет-такого.onnx', tokens: 'tokens.txt' }
      }),
      entries
    )
    expect(!r.ok && r.reason).toBe('missing')
  })

  it('незнакомое семейство отвергается вместе с его именем', () => {
    const r = readManifest(manifest({ family: 'llama.cpp', files: {} }), entries)
    expect(!r.ok && r.reason).toBe('badFamily')
    expect(!r.ok && 'detail' in r && r.detail).toBe('llama.cpp')
  })

  it('роль пропущена — говорим какая', () => {
    const r = readManifest(
      manifest({ family: 'whisper', files: { encoder: 'enc.onnx', tokens: 'tokens.txt' } }),
      entries
    )
    expect(!r.ok && r.reason).toBe('missing')
    expect(!r.ok && 'detail' in r && r.detail).toBe('decoder')
  })

  it('словарь обязателен и в манифесте', () => {
    const r = readManifest(
      manifest({ family: 'whisper', files: { encoder: 'enc.onnx', decoder: 'dec.onnx' } }),
      entries
    )
    expect(!r.ok && r.reason).toBe('missing')
  })

  it('не JSON и не объект — понятный отказ, а не исключение', () => {
    expect(!readManifest('{ сломано', entries).ok).toBe(true)
    expect((readManifest('{ сломано', entries) as { reason: string }).reason).toBe('badManifest')
    expect((readManifest('"строка"', entries) as { reason: string }).reason).toBe('badManifest')
    expect((readManifest('null', entries) as { reason: string }).reason).toBe('badManifest')
  })

  it('слишком длинные имя и язык обрезаются, а не ломают строку списка', () => {
    const r = readManifest(
      manifest({
        name: 'и'.repeat(500),
        lang: 'я'.repeat(500),
        family: 'whisper',
        files: { encoder: 'enc.onnx', decoder: 'dec.onnx', tokens: 'tokens.txt' }
      }),
      entries
    )
    expect(r.ok && r.name.length).toBe(60)
    expect(r.ok && r.lang.length).toBe(12)
  })
})

describe('список своих моделей', () => {
  const model = (dir: string): CustomSttModel => ({
    id: customId(dir),
    name: dir,
    lang: '',
    family: 'whisper',
    dir,
    files: { encoder: 'e.onnx', decoder: 'd.onnx', tokens: 't.txt' },
    bytes: 1
  })

  it('одна папка — одна запись: обновлённые файлы не плодят дубль', () => {
    const a = model('C:/models/whisper')
    const again = { ...model('C:/models/whisper'), bytes: 999 }
    const list = withCustom(withCustom([], a), again)
    expect(list.length).toBe(1)
    expect(list[0].bytes).toBe(999)
  })

  it('путь и есть тождество модели — слэши и регистр диска не считаются', () => {
    expect(customId('C:\\models\\whisper')).toBe(customId('c:/models/whisper/'))
    expect(customId('C:/models/whisper')).not.toBe(customId('C:/models/moonshine'))
  })

  it('новая встаёт первой, лишние уходят с хвоста', () => {
    let list: CustomSttModel[] = []
    for (let i = 0; i < CUSTOM_MAX + 3; i++) list = withCustom(list, model(`C:/m/${i}`))
    expect(list.length).toBe(CUSTOM_MAX)
    expect(list[0].dir).toBe(`C:/m/${CUSTOM_MAX + 2}`)
  })
})

describe('канонические папки sherpa-onnx', () => {
  it('две редакции одного файла — это одна модель, а не непонятная папка', () => {
    // Так выглядит официальная папка sense-voice: полная и квантованная модели
    // лежат рядом. Пока условие было «ровно один .onnx», ту самую мультиязычную
    // модель, ради которой всё затевалось, Заря отвергала как непонятную.
    const r = identifyModel('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', [
      f('model.onnx', 900_000_000),
      f('model.int8.onnx', 240_000_000),
      f('tokens.txt', 300_000)
    ])
    expect(r.ok && r.family).toBe('senseVoice')
    // Из редакций берётся крупная: она точнее, а место уже потрачено.
    expect(r.ok && r.files.model).toBe('model.onnx')
  })

  it('квантованные суффиксы не мешают: int8/fp16 — та же модель', () => {
    const r = identifyModel('sherpa-onnx-paraformer-zh', [
      f('model.fp16.onnx', 400_000_000),
      f('model.int8.onnx', 200_000_000),
      f('tokens.txt', 100)
    ])
    expect(r.ok && r.family).toBe('paraformer')
  })

  it('два РАЗНЫХ файла по-прежнему не считаются одной моделью', () => {
    const r = identifyModel('непонятная-папка', [
      f('acoustic.onnx', 100),
      f('language.onnx', 100),
      f('tokens.txt', 10)
    ])
    expect(r.ok).toBe(false)
  })

  it('«ctc» в имени папки больше не выдаётся за NeMo', () => {
    // sherpa-onnx-telespeech-ctc-* — другое семейство, которого аддон не знает
    // вовсе. Отдать его под nemoCtc — не догадка, а неправда: движок на такой
    // ошибке не ругается вежливо, он убивает процесс.
    const r = identifyModel('sherpa-onnx-telespeech-ctc-int8-zh-2024-06-04', [
      f('model.int8.onnx', 300_000_000),
      f('tokens.txt', 5000)
    ])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('unknown')
  })

  it('нормальные приметы NeMo работают по-прежнему', () => {
    const one = [f('model.int8.onnx', 200_000_000), f('tokens.txt', 2000)]
    expect((identifyModel('sherpa-onnx-nemo-ctc-punct-giga-am-v3', one) as { family: string }).family).toBe('nemoCtc')
    expect((identifyModel('gigaam-v3-ru-punct', one) as { family: string }).family).toBe('nemoCtc')
  })
})

describe('манифест и настоящие имена файлов', () => {
  it('имя на диск уходит из ПАПКИ, а не из манифеста', () => {
    // Linux: файл называется Small-Encoder.onnx, человек написал в манифесте
    // строчными. Сверка без учёта регистра — правильно; но записать надо
    // настоящее имя, иначе модель добавится и не откроется при загрузке.
    const entries = [f('Small-Encoder.onnx'), f('Small-Decoder.onnx'), f('Tokens.txt')]
    const r = readManifest(
      JSON.stringify({
        family: 'whisper',
        files: {
          encoder: 'small-encoder.onnx',
          decoder: 'small-decoder.onnx',
          tokens: 'tokens.txt'
        }
      }),
      entries
    )
    expect(r.ok && r.files.encoder).toBe('Small-Encoder.onnx')
    expect(r.ok && r.files.tokens).toBe('Tokens.txt')
  })
})
