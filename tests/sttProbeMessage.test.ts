import { describe, expect, it } from 'vitest'
import { firstLine } from '../src/main/sttService'

/**
 * Что человек прочитает, когда его модель не собралась.
 *
 * Отказ здесь — единственная замена падению: раньше движок на модели чужого
 * формата просто убивал приложение. Значит текст обязан вести к починке, а не
 * начинаться с пути к чужому исходнику на машине, где собирали библиотеку.
 */
describe('firstLine', () => {
  it('оставляет то, чего не хватило, отбрасывая путь к исходнику библиотеки', () => {
    const out = firstLine(
      "D:\\a\\sherpa-onnx\\sherpa-onnx\\sherpa-onnx\\csrc\\offline-sense-voice-model.cc:Init:118 'lfr_window_size' does not exist in the metadata"
    )
    expect(out).toBe("'lfr_window_size' does not exist in the metadata")
  })

  it('берёт последнюю строку: сообщение движка идёт после его же болтовни', () => {
    const out = firstLine('загрузка модели\nещё что-то\n/src/offline-model.cc:Check:42 tokens is empty')
    expect(out).toBe('tokens is empty')
  })

  it('строку без пути к исходнику оставляет как есть', () => {
    expect(firstLine('Load model failed: Protobuf parsing failed.')).toBe(
      'Load model failed: Protobuf parsing failed.'
    )
  })

  it('пустой вывод не превращается в «undefined» на экране', () => {
    expect(firstLine('')).toBe('')
    expect(firstLine('\n\n   \n')).toBe('')
  })

  it('длинный поток обрезается: это подпись под кнопкой, а не журнал', () => {
    expect(firstLine('x'.repeat(1000)).length).toBe(300)
  })
})
