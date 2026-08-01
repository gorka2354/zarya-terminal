import { describe, expect, it } from 'vitest'
import {
  MODELS_MAX,
  freshModels,
  parseModelList,
  prettyModelName,
  withSeen
} from '@shared/modelCatalog'

/**
 * Каталог моделей приходит из сети — то есть это чужие данные неизвестной формы.
 * Ошибка разбора здесь либо роняет главный процесс, либо тихо показывает пустой
 * список там, где человек выбирает, чем работать.
 */
describe('parseModelList', () => {
  it('читает ответ Anthropic и OpenAI ({data: [{id}]})', () => {
    const anthropic = {
      data: [
        { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' },
        { type: 'model', id: 'claude-fable-5', display_name: 'Claude Fable 5' }
      ]
    }
    expect(parseModelList(anthropic)).toEqual(['claude-opus-5', 'claude-fable-5'])
  })

  it('читает ответ Ollama ({models: [{name}]})', () => {
    expect(parseModelList({ models: [{ name: 'qwen3:8b' }, { name: 'llama4' }] })).toEqual([
      'qwen3:8b',
      'llama4'
    ])
  })

  it('чужая форма не роняет разбор, а даёт пустой список', () => {
    // Прокси, страница ошибки, редирект на HTML — всё это приходит по тому же
    // адресу, и «просто json.data.map» уронило бы главный процесс.
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList('<html>502</html>')).toEqual([])
    expect(parseModelList({ data: 'nope' })).toEqual([])
    expect(parseModelList({ data: [1, 2, null, {}] })).toEqual([])
  })

  it('дубли и пустые строки отбрасываются', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'a' }, { id: '  ' }, { id: 'b' }] })).toEqual([
      'a',
      'b'
    ])
  })

  it('длина списка ограничена', () => {
    const many = { data: Array.from({ length: MODELS_MAX + 25 }, (_, i) => ({ id: `m${i}` })) }
    expect(parseModelList(many)).toHaveLength(MODELS_MAX)
  })
})

describe('freshModels', () => {
  it('находит то, чего раньше не видели', () => {
    expect(freshModels(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c'])
  })

  it('молчит, когда нового нет', () => {
    expect(freshModels(['a', 'b'], ['b', 'a'])).toEqual([])
  })

  it('пропавшая и вернувшаяся модель новинкой не считается', () => {
    // Провайдер моргнул, модель на минуту исчезла из ответа — показать окно
    // «появилась новая модель» второй раз значит соврать.
    const seen = withSeen([], ['a', 'b'])
    expect(freshModels(seen, ['a'])).toEqual([])
    expect(freshModels(seen, ['a', 'b'])).toEqual([])
  })
})

describe('withSeen', () => {
  it('копит виденное без дублей', () => {
    expect(withSeen(['a'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('не растёт бесконечно', () => {
    const long = Array.from({ length: 200 }, (_, i) => `m${i}`)
    expect(withSeen(long, ['new'], 50)).toHaveLength(50)
    expect(withSeen(long, ['new'], 50)).toContain('new')
  })
})

describe('prettyModelName', () => {
  it('делает из идентификатора читаемое имя', () => {
    expect(prettyModelName('claude-opus-5')).toBe('Opus 5')
    expect(prettyModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4 5')
    expect(prettyModelName('claude-opus-5[1m]')).toBe('Opus 5 1M')
  })

  it('чужие имена не ломает', () => {
    expect(prettyModelName('gpt-5.2')).toBe('Gpt 5.2')
    expect(prettyModelName('qwen3:8b')).toBe('Qwen3:8b')
  })
})
