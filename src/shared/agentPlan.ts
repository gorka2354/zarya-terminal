/**
 * План агента — тот самый чек-лист, который консоль держит под строкой ввода.
 *
 * ЗАЧЕМ. Заря показывала следы работы агента и не показывала его НАМЕРЕНИЕ:
 * лента читалась как поток действий без цели, и на всякую заминку у человека был
 * один вопрос — «оно вообще движется?». План отвечает на него до того, как
 * вопрос возникнет: видно, что впереди и на каком шаге агент сейчас.
 *
 * КАК ЭТО ПРИХОДИТ. Обычными вызовами инструментов, без отдельного события:
 *
 *   tool_use  TaskCreate {subject, description?, activeForm?}
 *   result    «Task #3 created successfully: <subject>»      ← id только ЗДЕСЬ
 *   tool_use  TaskUpdate {taskId, status?, subject?, activeForm?}
 *
 * Идентификатора в `TaskCreate` нет вовсе — движок присваивает его сам и
 * называет в тексте результата. Поэтому создание запоминается по `toolUseId` и
 * превращается в задачу, только когда придёт результат с номером. Догадываться
 * (например, нумеровать подряд) нельзя: `TaskUpdate` придёт с настоящим номером,
 * и наш выдуманный с ним не сойдётся.
 */

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanTask {
  id: string
  subject: string
  /** «Запускаю тесты» — форма, которую движок показывает у идущей задачи. */
  activeForm?: string
  status: PlanStatus
}

/** Состояние плана беседы: задачи и ожидающие своего номера создания. */
export interface AgentPlan {
  tasks: PlanTask[]
  /** toolUseId → что создаётся; ждёт номера из результата. */
  awaiting: Record<string, { subject: string; activeForm?: string }>
}

export const EMPTY_PLAN: AgentPlan = { tasks: [], awaiting: {} }

function text(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

function asStatus(v: unknown): PlanStatus | 'deleted' | undefined {
  return v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'deleted'
    ? v
    : undefined
}

/** Номер задачи из текста результата: «Task #3 created successfully: …». */
export function taskIdFromResult(content: string): string | null {
  const m = /(?:Task|задач\w*)\s*#(\d+)/i.exec(content ?? '')
  return m ? m[1] : null
}

/**
 * Вызов инструмента — в план.
 *
 * `TaskCreate` только ЗАПОМИНАЕТСЯ (номера ещё нет), `TaskUpdate` применяется
 * сразу. Всё остальное план не трогает.
 */
export function planOnToolUse(
  plan: AgentPlan,
  toolUseId: string,
  name: string,
  input: unknown
): AgentPlan {
  const o = (input ?? null) as Record<string, unknown> | null
  if (name === 'TaskCreate') {
    const subject = text(o?.subject)
    if (!subject) return plan
    return {
      ...plan,
      awaiting: {
        ...plan.awaiting,
        [toolUseId]: { subject, activeForm: text(o?.activeForm) || undefined }
      }
    }
  }
  if (name === 'TaskUpdate') {
    const id = text(o?.taskId)
    if (!id) return plan
    const status = asStatus(o?.status)
    // Удалённую задачу убираем совсем: показывать её вычеркнутой значило бы
    // спорить с самим агентом о том, что входит в план.
    if (status === 'deleted') {
      const tasks = plan.tasks.filter((t) => t.id !== id)
      return tasks.length === plan.tasks.length ? plan : { ...plan, tasks }
    }
    const i = plan.tasks.findIndex((t) => t.id === id)
    // Обновление задачи, которой мы не видели (беседа продолжена, план завёлся
    // раньше) — заводим строку по тому, что есть: пусть неполная, но честная.
    if (i < 0) {
      const subject = text(o?.subject)
      if (!subject) return plan
      return {
        ...plan,
        tasks: [
          ...plan.tasks,
          { id, subject, activeForm: text(o?.activeForm) || undefined, status: status ?? 'pending' }
        ]
      }
    }
    const next = [...plan.tasks]
    next[i] = {
      ...next[i],
      subject: text(o?.subject) || next[i].subject,
      activeForm: text(o?.activeForm) || next[i].activeForm,
      status: status ?? next[i].status
    }
    return { ...plan, tasks: next }
  }
  return plan
}

/** Результат инструмента — момент, когда у созданной задачи появляется номер. */
export function planOnToolResult(plan: AgentPlan, toolUseId: string, content: string): AgentPlan {
  const pending = plan.awaiting[toolUseId]
  if (!pending) return plan
  const awaiting = { ...plan.awaiting }
  delete awaiting[toolUseId]
  const id = taskIdFromResult(content)
  // Номера нет — значит создание не удалось (или движок ответил иначе).
  // Придумывать свой нельзя: следующий TaskUpdate с ним не сойдётся.
  if (!id) return { ...plan, awaiting }
  if (plan.tasks.some((t) => t.id === id)) return { ...plan, awaiting }
  return {
    ...plan,
    awaiting,
    tasks: [
      ...plan.tasks,
      { id, subject: pending.subject, activeForm: pending.activeForm, status: 'pending' }
    ]
  }
}

/** Сколько сделано и что идёт прямо сейчас — для свёрнутой строки. */
export function planSummary(plan: AgentPlan): {
  total: number
  done: number
  running?: PlanTask
} {
  const total = plan.tasks.length
  const done = plan.tasks.filter((t) => t.status === 'completed').length
  const running = plan.tasks.find((t) => t.status === 'in_progress')
  return running ? { total, done, running } : { total, done }
}
