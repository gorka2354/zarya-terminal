import { describe, expect, it } from 'vitest'
import { flattenForProvider } from '../src/main/aiProxy'
import type { AiMessage } from '@shared/types'

/**
 * Граница с обычным провайдером: наши собственные виды частей наружу не едут.
 *
 * Цена ошибки здесь несимметрична. Anthropic на неизвестный блок отвечает 400, и
 * сообщение остаётся в истории — беседа ломается НАВСЕГДА, каждый следующий ход
 * упирается в ту же ошибку. У OpenAI мягче и хуже: часть молча отфильтруется, и
 * модель ответит на то, чего не видела.
 */
const user = (...content: AiMessage['content']): AiMessage => ({
  role: 'user',
  content,
  ts: 0
})
const assistant = (text: string): AiMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  ts: 0
})
const tail = (text: string, cmds = ['ls']): AiMessage['content'][number] => ({
  type: 'shell-tail',
  text,
  used: cmds.map((command) => ({ command }))
})

describe('flattenForProvider — наши виды частей наружу не едут', () => {
  it('записка соседа становится текстом С ПОМЕТКОЙ, а не голым текстом', () => {
    const out = flattenForProvider([user({ type: 'pane-note', from: 'сборка', text: 'готово' })])
    expect(out[0].content[0]).toEqual({ type: 'text', text: '[note from pane "сборка"] готово' })
  })

  it('ни одной части нашего вида не остаётся', () => {
    const out = flattenForProvider([
      user(tail('консоль'), { type: 'text', text: 'почему упало?' })
    ])
    const kinds = out.flatMap((m) => m.content.map((p) => p.type))
    expect(kinds).not.toContain('shell-tail')
    expect(kinds).not.toContain('pane-note')
  })
})

describe('flattenForProvider — хвост консоли живёт один ход', () => {
  const history: AiMessage[] = [
    user(tail('старая консоль', ['git log']), { type: 'text', text: 'первый вопрос' }),
    assistant('первый ответ'),
    user(tail('свежая консоль', ['npm test']), { type: 'text', text: 'второй вопрос' })
  ]

  it('у последнего хода хвост остаётся', () => {
    const out = flattenForProvider(history)
    expect(JSON.stringify(out[2].content)).toContain('свежая консоль')
  })

  it('из прежних ходов хвост выброшен — иначе десятый ход тащил бы десять снимков', () => {
    const out = flattenForProvider(history)
    expect(JSON.stringify(out[0].content)).not.toContain('старая консоль')
    // Слова человека при этом на месте: выбрасываем хвост, а не ход.
    expect(JSON.stringify(out[0].content)).toContain('первый вопрос')
  })

  it('хвост без текста (поднят с диска) не едет даже последним', () => {
    // На диске от хвоста остаётся только список команд — отправлять нечего.
    const out = flattenForProvider([user(tail(''), { type: 'text', text: 'вопрос' })])
    expect(out[0].content).toEqual([{ type: 'text', text: 'вопрос' }])
  })
})

describe('flattenForProvider — агентский цикл не съедает хвост', () => {
  /*
   * Поймано ревью. Итог инструмента приезжает сообщением РОЛИ `user` — так
   * устроен протокол, — и «последний user» внутри цикла оказывался им, а не
   * ходом человека. Хвост выбрасывался со второго запроса того же хода, то есть
   * ровно там, где агент выполняет команды и вывод консоли нужен ему больше
   * всего. Считаем по самой части, а не по роли.
   */
  const toolResult = (): AiMessage => ({
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: 't1', content: 'готово' }],
    ts: 0
  })
  const toolUse = (): AiMessage => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: {} }],
    ts: 0
  })

  it('хвост переживает вызов инструмента внутри того же хода', () => {
    const out = flattenForProvider([
      user(tail('консоль человека'), { type: 'text', text: 'почини' }),
      toolUse(),
      toolResult()
    ])
    expect(JSON.stringify(out[0].content)).toContain('консоль человека')
  })

  it('и переживает НЕСКОЛЬКО кругов цикла', () => {
    const out = flattenForProvider([
      user(tail('консоль человека'), { type: 'text', text: 'почини' }),
      toolUse(),
      toolResult(),
      toolUse(),
      toolResult()
    ])
    expect(JSON.stringify(out[0].content)).toContain('консоль человека')
  })

  it('а новый ход человека всё равно вытесняет прежний хвост', () => {
    const out = flattenForProvider([
      user(tail('старая'), { type: 'text', text: 'раз' }),
      toolUse(),
      toolResult(),
      user(tail('свежая'), { type: 'text', text: 'два' })
    ])
    expect(JSON.stringify(out[0].content)).not.toContain('старая')
    expect(JSON.stringify(out[3].content)).toContain('свежая')
  })
})

describe('flattenForProvider — сообщение не остаётся пустым', () => {
  /*
   * Инвариант, на который опирается фильтр хвоста: рядом с ним ВСЕГДА есть
   * другая часть, потому что `send` не пускает отправку без слов, картинки или
   * контекста. Пустой `content` провайдер встречает четырёхсотой, и разговор
   * встаёт навсегда, — поэтому инвариант проверяется, а не подразумевается.
   */
  it('ни одно сообщение не теряет весь свой контент', () => {
    const messages: AiMessage[] = [
      user(tail('a'), { type: 'text', text: 'слова' }),
      assistant('ответ'),
      user(tail('b'), { type: 'image', mediaType: 'image/png', data: 'x', bytes: 1, width: 1, height: 1 }),
      user(tail('c'), { type: 'pane-note', from: 'сосед', text: 'записка' }),
      user(tail('d'), { type: 'text', text: 'последний' })
    ]
    for (const m of flattenForProvider(messages)) {
      expect(m.content.length).toBeGreaterThan(0)
    }
  })

  it('ходы и их порядок не меняются — чередование ролей провайдер проверяет сам', () => {
    const messages: AiMessage[] = [
      user({ type: 'text', text: 'раз' }),
      assistant('два'),
      user(tail('t'), { type: 'text', text: 'три' })
    ]
    const out = flattenForProvider(messages)
    expect(out).toHaveLength(3)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })
})
