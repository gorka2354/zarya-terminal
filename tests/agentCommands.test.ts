import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  cleanCommands,
  commandQuery,
  matchCommands,
  type AgentCommand
} from '@shared/agentCommands'

/**
 * Команды агента — то, что человек набирает через «/».
 *
 * Проверяется не «работает ли список», а три места, где такие списки обычно
 * врут: список выскакивает посреди пути, точное совпадение оказывается не
 * первым, и в списке лежит служебный мусор движка.
 */
const cmd = (name: string, extra: Partial<AgentCommand> = {}): AgentCommand => ({
  name,
  description: '',
  ...extra
})

describe('cleanCommands', () => {
  it('снимает ведущий слэш — источники его не согласовали', () => {
    const out = cleanCommands([{ name: '/plan' }, { name: 'review' }])
    expect(out.map((c) => c.name)).toEqual(['plan', 'review'])
  })

  it('схлопывает дубли: один скилл приходит и как проектный, и как плагин', () => {
    // Живой ответ SDK содержал review трижды, gstack и browse — дважды.
    const out = cleanCommands([
      { name: 'review', description: 'первый' },
      { name: 'review', description: 'второй' },
      { name: 'Review', description: 'третий' }
    ])
    expect(out.length).toBe(1)
    expect(out[0].description).toBe('первый')
  })

  it('прячет служебное, чему нечего делать перед человеком', () => {
    const out = cleanCommands([
      { name: '__remote-workflow' },
      { name: 'workflow-launch-exec' },
      { name: 'heapdump' },
      { name: 'plan' }
    ])
    expect(out.map((c) => c.name)).toEqual(['plan'])
  })

  it('переживает мусор вместо списка, а не роняет окно', () => {
    expect(cleanCommands(null)).toEqual([])
    expect(cleanCommands('строка')).toEqual([])
    expect(cleanCommands([null, 42, { nope: 1 }, { name: '' }])).toEqual([])
  })

  it('пустая подсказка аргументов — это отсутствие подсказки', () => {
    const out = cleanCommands([{ name: 'a', argumentHint: '   ' }, { name: 'b', argumentHint: '<file>' }])
    expect(out[0].argumentHint).toBeUndefined()
    expect(out[1].argumentHint).toBe('<file>')
  })
})

describe('commandQuery — когда список вообще открывается', () => {
  it('слэш первым символом строки — да', () => {
    expect(commandQuery('/', 1)).toBe('')
    expect(commandQuery('/rev', 4)).toBe('rev')
    expect(commandQuery('  /rev', 6)).toBe('rev')
  })

  it('слэш в пути — НИКОГДА', () => {
    // Главная жалоба на чужие реализации: список выскакивает посреди набора
    // пути и съедает следующее нажатие.
    expect(commandQuery('src/main/ipc.ts', 15)).toBeNull()
    expect(commandQuery('cd src/', 7)).toBeNull()
    expect(commandQuery('https://example.com', 19)).toBeNull()
    expect(commandQuery('посмотри /etc/hosts', 19)).toBeNull()
  })

  it('слэш в середине слова — тоже нет', () => {
    expect(commandQuery('и/или', 5)).toBeNull()
  })

  it('после переноса строки счёт начинается заново', () => {
    expect(commandQuery('первая строка\n/pl', 17)).toBe('pl')
    expect(commandQuery('первая строка\nтекст /pl', 22)).toBeNull()
  })

  it('каретка позади слэша — список закрыт', () => {
    // Человек ушёл стрелкой в начало: показывать список над текстом, который он
    // не набирает, значит мешать.
    expect(commandQuery('/review', 0)).toBeNull()
  })
})

describe('matchCommands — точное совпадение всегда первое', () => {
  const list = [
    cmd('review-pr', { description: 'разобрать пулл-реквест' }),
    cmd('review', { description: 'code review' }),
    cmd('rewind', { description: 'откатиться' }),
    cmd('usage', { description: 'лимиты', aliases: ['cost', 'stats'] })
  ]

  it('«review» ставит review выше review-pr', () => {
    // В самом Claude Code это открытый баг: Enter запускает не ту команду.
    expect(matchCommands(list, 'review').map((c) => c.name)).toEqual(['review', 'review-pr'])
  })

  it('по началу имени', () => {
    expect(matchCommands(list, 're').map((c) => c.name)).toEqual(['review', 'review-pr', 'rewind'])
  })

  it('находит по псевдониму — человек помнит /cost, а команда зовётся usage', () => {
    expect(matchCommands(list, 'cost').map((c) => c.name)).toEqual(['usage'])
  })

  it('находит по описанию, но ниже совпадений по имени', () => {
    const out = matchCommands(list, 'откатиться')
    expect(out.map((c) => c.name)).toEqual(['rewind'])
  })

  it('пустой запрос отдаёт весь список как есть', () => {
    expect(matchCommands(list, '').length).toBe(list.length)
  })

  it('ничего не найдено — пусто, а не весь список', () => {
    expect(matchCommands(list, 'щщщ')).toEqual([])
  })
})

describe('applyCommand — что оказывается в строке', () => {
  it('команда без аргументов вставляется без хвостового пробела', () => {
    // Иначе перед отправкой человеку пришлось бы стирать пробел — лишнее
    // нажатие в самом частом жесте.
    const r = applyCommand('/rev', 4, cmd('rewind'))
    expect(r.text).toBe('/rewind')
    expect(r.caret).toBe(7)
  })

  it('команда с аргументами — с пробелом, курсор за ним', () => {
    const r = applyCommand('/rev', 4, cmd('review', { argumentHint: '<file>' }))
    expect(r.text).toBe('/review ')
    expect(r.caret).toBe(8)
  })

  it('текст справа от каретки не теряется', () => {
    const r = applyCommand('/rev хвост', 4, cmd('review', { argumentHint: '<file>' }))
    expect(r.text).toBe('/review  хвост')
  })

  it('на второй строке заменяется только она', () => {
    const r = applyCommand('первая\n/pl', 10, cmd('plan'))
    expect(r.text).toBe('первая\n/plan')
  })
})
