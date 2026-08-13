/**
 * Задачи движка: что показывать и чем они кончились.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Обе решения жили внутри цикла разбора сообщений в
 * драйвере — и потому не проверялись ничем. Прогоны ленты гоняют фейковый
 * драйвер, который шлёт готовые события МИМО этого кода, так что настоящая
 * ошибка классификации (см. ниже) могла вернуться незамеченной. Здесь это
 * чистые функции, и у каждой есть тест на настоящих формах SDK.
 *
 * ЧТО ЗА ОШИБКА. Раньше в драйвере стоял белый список: всё, у чего род не
 * `local_agent`, замолкало НАВСЕГДА. Комментарий объяснял это фильтром обычных
 * команд оболочки — но под тот же нож попал `Workflow` (род `local_workflow`) и
 * длительный `Monitor`. Человек видел «запущено в фоне» и дальше тишину: ни что
 * работает, ни чем кончилось. Белый список тут в принципе неверен: список родов
 * у движка открытый, и каждый новый по умолчанию исчезал бы с экрана.
 */

/**
 * Показывать ли задачу в ленте.
 *
 * Прячем ровно две вещи:
 *
 * 1. То, что движок сам пометил служебным (`skip_transcript`) — это его прямое
 *    указание «не показывай в ленте», и спорить с ним нам не о чем.
 * 2. Обычные команды оболочки (`local_bash`): у них своя карточка в ленте, а в
 *    счётчике задач они раздували бы «N из M».
 *
 * Всё остальное — ПОКАЗЫВАЕМ, включая незнакомое. Молчание о новом уже стоило
 * нам целого `Workflow`; повторять эту ошибку с открытым списком родов значит
 * гарантировать её повторение.
 */
export function taskHidden(taskType: string | undefined, skipTranscript?: boolean): boolean {
  return skipTranscript === true || taskType === 'local_bash'
}

/** Исход задачи, как его называет движок. */
export type TaskOutcome = 'completed' | 'failed' | 'stopped'

/**
 * Чем кончилась задача — из того события, которое об этом сказало.
 *
 * Движок сообщает исход двумя путями: `task_notification` несёт его словом
 * (`completed`/`failed`/`stopped`), а `task_updated` — статусом в патче, где
 * есть ещё и `killed`. `killed` — это ОСТАНОВЛЕННАЯ задача, а не упавшая:
 * разница в том, кто её прекратил, и человеку она видна.
 *
 * Раньше не читалось ничего из этого: признаком конца служило одно только
 * `patch.status === 'completed'`, поэтому упавшая задача навсегда оставалась
 * «идущей», а в счётчике все выглядели одинаково успешными.
 */
export function taskOutcome(
  subtype: string,
  status: string | undefined,
  patchStatus: string | undefined
): TaskOutcome | undefined {
  if (subtype === 'task_notification') {
    return status === 'completed' || status === 'failed' || status === 'stopped'
      ? status
      : undefined
  }
  if (patchStatus === 'completed') return 'completed'
  if (patchStatus === 'failed') return 'failed'
  if (patchStatus === 'killed') return 'stopped'
  return undefined
}

/**
 * Задача закончилась?
 *
 * `task_notification` движок шлёт только по завершении — даже если исхода в нём
 * не разобрать (старый CLI, новое слово). Конец есть конец: оставить такую
 * задачу крутиться значило бы показывать работу, которой уже нет.
 */
export function taskDone(subtype: string, outcome: TaskOutcome | undefined): boolean {
  return subtype === 'task_notification' || !!outcome
}

/** Живая фоновая задача — как её называет уровневое сообщение движка. */
export interface BackgroundTask {
  taskId: string
  /** Род: `local_bash`, `local_agent`, `local_workflow` и что появится дальше. */
  taskType: string
  description: string
}

/**
 * Кто сейчас в фоне — из `background_tasks_changed`.
 *
 * ЭТО УРОВЕНЬ, А НЕ РЕБРО, и документация SDK настаивает на этом отдельно:
 * набор надо ЗАМЕНЯТЬ целиком, а не собирать из пар «началось / кончилось».
 * Собранное из рёбер множество однажды потеряет пару — и счётчик «в фоне 1»
 * останется гореть навсегда над пустотой. Поэтому прежнее множество здесь не
 * участвует вовсе: функция принимает только payload.
 *
 * РОД НЕ ФИЛЬТРУЕМ, в отличие от `taskHidden`. Там `local_bash` прячется
 * потому, что у команды оболочки есть своя карточка в ленте. Здесь наоборот:
 * ушедшая в фон `npm run build` — главное, что человек хочет видеть в счётчике.
 */
export function backgroundSet(
  payload: { task_id?: string; task_type?: string; description?: string }[] | undefined
): BackgroundTask[] {
  if (!Array.isArray(payload)) return []
  const seen = new Set<string>()
  const out: BackgroundTask[] = []
  for (const t of payload) {
    const id = typeof t?.task_id === 'string' ? t.task_id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      taskId: id,
      taskType: typeof t.task_type === 'string' ? t.task_type : '',
      description: typeof t.description === 'string' ? t.description.trim() : ''
    })
  }
  return out
}

/**
 * Показывать ли кнопку «В фон».
 *
 * Три отказа, и каждый — про то, что кнопка иначе соврёт:
 *
 * - задача уже кончилась: отправлять в фон нечего;
 * - она уже в фоне: движок вернёт «ничего не сделал», а человек решит, что
 *   сделал;
 * - `tool_use` неизвестен: адресовать задачу движку нечем. Без него можно
 *   только «всё в фон», а это другая кнопка и другое обещание.
 */
export function canBackground(task: {
  phase?: 'started' | 'progress' | 'done'
  backgrounded?: boolean
  toolUseId?: string
}): boolean {
  if (task.phase === 'done') return false
  if (task.backgrounded) return false
  return !!task.toolUseId
}
