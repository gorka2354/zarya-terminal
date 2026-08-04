import { describe, expect, it } from 'vitest'
import {
  EMPTY_PLAN,
  planOnToolResult,
  planOnToolUse,
  planSummary,
  taskIdFromResult
} from '@shared/agentPlan'

/**
 * План агента собирается из обычных вызовов инструментов — отдельного события у
 * движка нет. Главная тонкость: у `TaskCreate` НЕТ идентификатора, движок
 * называет его только в тексте результата («Task #3 created successfully: …»),
 * а `TaskUpdate` приходит уже с этим номером. Значит создание обязано ждать
 * результата, а не заводить задачу сразу.
 *
 * Входы взяты из настоящих записей Claude Code на машине владельца.
 */
const create = (plan: typeof EMPTY_PLAN, toolUseId: string, subject: string, activeForm?: string) =>
  planOnToolUse(plan, toolUseId, 'TaskCreate', { subject, activeForm })

describe('номер задачи приходит в результате, а не во входе', () => {
  it('номер вынимается из текста движка', () => {
    expect(taskIdFromResult('Task #3 created successfully: Написать trunk')).toBe('3')
    expect(taskIdFromResult('Task #16 created successfully: Скиллы')).toBe('16')
  })

  it('нет номера — нет и задачи: выдумывать свой нельзя', () => {
    // Придуманный номер не сойдётся со следующим TaskUpdate, и план разъедется.
    let p = create(EMPTY_PLAN, 'tu-1', 'Первая задача')
    p = planOnToolResult(p, 'tu-1', 'что-то пошло не так')
    expect(p.tasks).toEqual([])
    expect(Object.keys(p.awaiting)).toEqual([])
  })

  it('создание ждёт результата и только тогда становится строкой', () => {
    let p = create(EMPTY_PLAN, 'tu-1', 'Написать trunk', 'Пишу ядро')
    // До результата задачи ещё нет — показывать нечего.
    expect(p.tasks).toEqual([])
    expect(p.awaiting['tu-1'].subject).toBe('Написать trunk')
    p = planOnToolResult(p, 'tu-1', 'Task #1 created successfully: Написать trunk')
    expect(p.tasks).toEqual([
      { id: '1', subject: 'Написать trunk', activeForm: 'Пишу ядро', status: 'pending' }
    ])
    expect(p.awaiting).toEqual({})
  })

  it('чужой результат план не трогает', () => {
    let p = create(EMPTY_PLAN, 'tu-1', 'Задача')
    p = planOnToolResult(p, 'другой-инструмент', 'Task #9 created successfully: чужое')
    expect(p.tasks).toEqual([])
    expect(p.awaiting['tu-1']).toBeTruthy()
  })
})

describe('движение по плану', () => {
  const withThree = (): typeof EMPTY_PLAN => {
    let p = EMPTY_PLAN
    for (const [i, subj] of ['Первая', 'Вторая', 'Третья'].entries()) {
      p = create(p, `tu-${i}`, subj)
      p = planOnToolResult(p, `tu-${i}`, `Task #${i + 1} created successfully: ${subj}`)
    }
    return p
  }

  it('статус меняется по номеру', () => {
    let p = withThree()
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '2', status: 'in_progress' })
    expect(p.tasks.map((t) => t.status)).toEqual(['pending', 'in_progress', 'pending'])
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '2', status: 'completed' })
    expect(p.tasks.map((t) => t.status)).toEqual(['pending', 'completed', 'pending'])
  })

  it('порядок задач не прыгает при обновлении', () => {
    let p = withThree()
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '1', status: 'completed' })
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '3', status: 'in_progress' })
    expect(p.tasks.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  it('движок вправе переписать текст задачи на ходу', () => {
    let p = withThree()
    p = planOnToolUse(p, 'x', 'TaskUpdate', {
      taskId: '1',
      subject: 'Первая, уточнённая',
      activeForm: 'Уточняю'
    })
    expect(p.tasks[0].subject).toBe('Первая, уточнённая')
    expect(p.tasks[0].activeForm).toBe('Уточняю')
    // Статус не назвали — он и не меняется.
    expect(p.tasks[0].status).toBe('pending')
  })

  it('удалённая задача уходит из плана', () => {
    let p = withThree()
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '2', status: 'deleted' })
    expect(p.tasks.map((t) => t.id)).toEqual(['1', '3'])
  })

  it('обновление незнакомой задачи заводит строку, если названа тема', () => {
    // Беседу могли продолжить: план завёлся до того, как Заря начала смотреть.
    let p = planOnToolUse(EMPTY_PLAN, 'x', 'TaskUpdate', {
      taskId: '7',
      subject: 'Из прошлой сессии',
      status: 'in_progress'
    })
    expect(p.tasks).toEqual([
      { id: '7', subject: 'Из прошлой сессии', activeForm: undefined, status: 'in_progress' }
    ])
    // А без темы показывать нечего — молчим, а не рисуем пустую строку.
    p = planOnToolUse(EMPTY_PLAN, 'x', 'TaskUpdate', { taskId: '8', status: 'completed' })
    expect(p.tasks).toEqual([])
  })
})

describe('свёрнутая строка плана', () => {
  it('считает сделанное и называет текущее', () => {
    let p = EMPTY_PLAN
    for (const [i, subj] of ['Раз', 'Два'].entries()) {
      p = create(p, `t${i}`, subj, `Делаю ${subj}`)
      p = planOnToolResult(p, `t${i}`, `Task #${i + 1} created successfully: ${subj}`)
    }
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '1', status: 'completed' })
    p = planOnToolUse(p, 'x', 'TaskUpdate', { taskId: '2', status: 'in_progress' })
    const s = planSummary(p)
    expect(s).toMatchObject({ total: 2, done: 1 })
    expect(s.running?.subject).toBe('Два')
  })

  it('пустой план ничего не выдумывает', () => {
    expect(planSummary(EMPTY_PLAN)).toEqual({ total: 0, done: 0 })
  })
})

describe('чужие инструменты план не трогают', () => {
  it('Bash, Read и прочее проходят мимо', () => {
    const p = planOnToolUse(EMPTY_PLAN, 'x', 'Bash', { command: 'npm test' })
    expect(p).toBe(EMPTY_PLAN)
  })

  it('мусор вместо входа не роняет разбор', () => {
    expect(planOnToolUse(EMPTY_PLAN, 'x', 'TaskCreate', null).tasks).toEqual([])
    expect(planOnToolUse(EMPTY_PLAN, 'x', 'TaskUpdate', { taskId: '' }).tasks).toEqual([])
    expect(planOnToolUse(EMPTY_PLAN, 'x', 'TaskUpdate', { taskId: '1', status: 'странно' }).tasks)
      .toEqual([])
  })
})
