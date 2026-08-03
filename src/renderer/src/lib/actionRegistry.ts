/**
 * Global action registry. Core features register actions here; the command
 * palette lists them and the keybinding dispatcher runs them by id.
 * Action ids double as keybinding keys in settings.keybindings.
 */
export interface AppAction {
  id: string
  title: string
  category: string
  /** Extra search keywords for the palette. */
  keywords?: string
  run: () => void | Promise<void>
  /** When returns false the action is hidden/disabled. */
  enabled?: () => boolean
}

const actions = new Map<string, AppAction>()
const listeners = new Set<() => void>()

export function registerAction(action: AppAction): () => void {
  actions.set(action.id, action)
  listeners.forEach((l) => l())
  return () => {
    actions.delete(action.id)
    listeners.forEach((l) => l())
  }
}

export function registerActions(list: AppAction[]): () => void {
  const unsubs = list.map(registerAction)
  return () => unsubs.forEach((u) => u())
}

export function getAllActions(): AppAction[] {
  return [...actions.values()].filter((a) => a.enabled?.() !== false)
}

export function getAction(id: string): AppAction | undefined {
  return actions.get(id)
}

export function runAction(id: string): void {
  const a = actions.get(id)
  if (!a || a.enabled?.() === false) return
  void a.run()
}

/** Subscribe to registry changes (palette re-render). */
export function onActionsChanged(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/*
 * QA-хук: выполнить действие по id и посмотреть список доступных.
 *
 * Прогоны обязаны проверять действие ровно так, как его вызывает клавиша или
 * палитра, — через `runAction`, вместе с гейтом `enabled`. Иначе проверка
 * доказывала бы работу кода, до которого человек может и не дотянуться.
 */
;(
  window as unknown as {
    __zaryaRunAction?: (id: string) => void
    __zaryaActions?: () => { id: string; title: string; category: string }[]
  }
).__zaryaRunAction = runAction
;(
  window as unknown as { __zaryaActions?: () => { id: string; title: string; category: string }[] }
).__zaryaActions = () =>
  getAllActions().map((a) => ({ id: a.id, title: a.title, category: a.category }))
