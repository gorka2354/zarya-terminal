import { describe, expect, it } from 'vitest'
import { taskDone, taskHidden, taskOutcome } from '@shared/agentTasks'

/**
 * Классификация задач движка — тот самый код, где жила НАСТОЯЩАЯ ошибка:
 * белый список `task_type !== 'local_agent'` глушил навсегда всё, кроме
 * субагентов, и вместе с командами оболочки под нож попал `Workflow` (род
 * `local_workflow`). Человек видел «запущено в фоне» и дальше тишину.
 *
 * Проверять это на экране нечем: прогоны ленты гоняют фейковый драйвер, а он
 * шлёт готовые события МИМО этого кода. Поэтому решения вынесены в чистые
 * функции, и формы здесь — из `sdk.d.ts` дословно.
 */
describe('что прячем из ленты', () => {
  it('служебную задачу — движок сам сказал не показывать', () => {
    // `skip_transcript`: «Ambient/housekeeping task. Consumers should hide this
    // from the inline transcript» — прямое указание, спорить не о чем.
    expect(taskHidden('local_agent', true)).toBe(true)
    expect(taskHidden(undefined, true)).toBe(true)
  })

  it('обычную команду оболочки — у неё своя карточка', () => {
    expect(taskHidden('local_bash', undefined)).toBe(true)
  })

  it('субагента и воркфлоу — показываем', () => {
    expect(taskHidden('local_agent', undefined)).toBe(false)
    // Ради этой строки всё и затевалось: раньше воркфлоу молчал навсегда.
    expect(taskHidden('local_workflow', undefined)).toBe(false)
    expect(taskHidden('local_workflow', false)).toBe(false)
  })

  it('НЕЗНАКОМЫЙ род — тоже показываем', () => {
    // Список родов у движка открытый. Белый список уже проглотил `Workflow`
    // целиком; с ним каждый новый род исчезал бы с экрана по умолчанию, и мы
    // узнавали бы об этом через полгода, как в прошлый раз.
    expect(taskHidden('remote_agent', undefined)).toBe(false)
    expect(taskHidden('local_monitor', undefined)).toBe(false)
    expect(taskHidden(undefined, undefined)).toBe(false)
  })
})

describe('чем задача кончилась', () => {
  it('слово движка из уведомления', () => {
    expect(taskOutcome('task_notification', 'completed', undefined)).toBe('completed')
    expect(taskOutcome('task_notification', 'failed', undefined)).toBe('failed')
    expect(taskOutcome('task_notification', 'stopped', undefined)).toBe('stopped')
  })

  it('статус из патча — и killed это ОСТАНОВЛЕНА, а не упала', () => {
    // Разница в том, кто прекратил задачу. Человеку она видна, и сваливать
    // остановку в неудачу значило бы обвинить агента в чужом решении.
    expect(taskOutcome('task_updated', undefined, 'completed')).toBe('completed')
    expect(taskOutcome('task_updated', undefined, 'failed')).toBe('failed')
    expect(taskOutcome('task_updated', undefined, 'killed')).toBe('stopped')
  })

  it('промежуточные статусы исходом не считаются', () => {
    expect(taskOutcome('task_updated', undefined, 'running')).toBeUndefined()
    expect(taskOutcome('task_updated', undefined, 'pending')).toBeUndefined()
    expect(taskOutcome('task_updated', undefined, 'paused')).toBeUndefined()
  })

  it('незнакомое слово не выдаётся за исход', () => {
    // Придумать «наверное, упало» так же нечестно, как спрятать неудачу.
    expect(taskOutcome('task_notification', 'что-то новое', undefined)).toBeUndefined()
    expect(taskOutcome('task_progress', undefined, undefined)).toBeUndefined()
  })

  it('прогресс не путается с патчем', () => {
    // `task_progress` статуса не несёт вовсе — читать его оттуда нечего.
    expect(taskOutcome('task_progress', 'completed', undefined)).toBeUndefined()
  })
})

describe('закончилась ли задача', () => {
  it('уведомление означает конец даже без разобранного исхода', () => {
    // Старый CLI мог не прислать знакомого слова. Конец есть конец: оставить
    // задачу крутиться значило бы показывать работу, которой уже нет.
    expect(taskDone('task_notification', undefined)).toBe(true)
  })

  it('патч с исходом — тоже конец', () => {
    expect(taskDone('task_updated', 'failed')).toBe(true)
    expect(taskDone('task_updated', 'stopped')).toBe(true)
  })

  it('без исхода задача продолжается', () => {
    expect(taskDone('task_updated', undefined)).toBe(false)
    expect(taskDone('task_progress', undefined)).toBe(false)
    expect(taskDone('task_started', undefined)).toBe(false)
  })
})
