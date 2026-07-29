import { useSessionsStore } from '@/state/sessionsStore'
import { useUiStore } from '@/state/uiStore'

/**
 * Диспетчер Esc и Enter — один на окно.
 *
 * Раньше эти клавиши слушала сама строка ввода. Пока строка была одна, это
 * работало: слушатель окна находил «активную беседу» и одобрял ожидающую команду.
 * С несколькими панелями (inc-17) строк становится столько же, сколько панелей, —
 * и одно нажатие обслуживают ВСЕ слушатели по очереди. Первая карточка помечается
 * решённой мгновенно, поэтому следующая копия обработчика хватает следующую: один
 * Enter одобряет несколько команд подряд, а один Esc отклоняет ожидающее во всех
 * панелях сразу. Это ровно то слепое «да», ради которого гейты и существуют.
 *
 * Поэтому слушатель здесь ровно один. Панели не слушают окно — они
 * РЕГИСТРИРУЮТСЯ, а диспетчер решает, кому адресовано нажатие, и отдаёт его
 * одному адресату.
 */

/** Что панель умеет делать с клавишей. `true` — нажатие обработано и дальше не идёт. */
export interface PaneKeyHandlers {
  /**
   * У Esc несколько смыслов, и порядок между ними важен. Отмена диктовки идёт
   * ВЫШЕ оверлеев: запись идёт прямо сейчас, и прервать её надо, что бы ни было
   * открыто. Остальные смыслы (отклонить ожидающее → вернуть очередь → отменить
   * отправленное → прервать ход) работают, только когда окно не занято палитрой,
   * настройками или сырым терминалом — поэтому панель получает это признаком.
   */
  onEscape?: (ctx: { overlayOpen: boolean }) => boolean
  onEnter?: (e: KeyboardEvent) => boolean
}

const panes = new Map<string, PaneKeyHandlers>()

/**
 * Заявить обработчики своей панели. Ключ — sessionId, а не «активная панель»:
 * панель должна знать только про себя, иначе строка ввода снова начнёт
 * спрашивать «а какая сейчас активная» и печатать в чужую оболочку.
 */
export function registerPaneKeys(sessionId: string, handlers: PaneKeyHandlers): () => void {
  panes.set(sessionId, handlers)
  return () => {
    if (panes.get(sessionId) === handlers) panes.delete(sessionId)
  }
}

/**
 * Кому адресовано нажатие. Сегодня это активная панель вкладки; когда появится
 * явный владелец фокуса (курсор в панели делает её активной), менять придётся
 * только здесь.
 */
export function keyTargetSessionId(): string | null {
  return useSessionsStore.getState().activeSessionId()
}

/** Панель, которой сейчас достанутся Esc и Enter, — по ней рисуется подпись «Enter · Esc». */
export function isKeyTarget(sessionId: string | null | undefined): boolean {
  return !!sessionId && keyTargetSessionId() === sessionId
}

/**
 * Оверлеи забирают Esc себе: палитра, настройки, пусковой пульт, быстрый переход,
 * хроника, командная строка. В сыром режиме терминала клавиши принадлежат
 * программе внутри него.
 */
function overlayOwnsKeys(): boolean {
  const ui = useUiStore.getState()
  return (
    ui.paletteOpen ||
    ui.settingsOpen ||
    ui.launchPadOpen ||
    ui.quickOpenOpen ||
    ui.historyOverlayOpen ||
    ui.aiBarOpen ||
    ui.rawTerminal
  )
}

let installed = false

/** Поставить единственный слушатель окна. Вызывается один раз при старте. */
export function installKeyRouter(): () => void {
  if (installed) return () => undefined
  installed = true
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return
    // SECURITY: гейт одобряет только ГОЛЫЙ Enter. Shift/Ctrl+Enter — это «новая
    // строка» в поле ввода, и одобрять запуск инструмента потому, что человек
    // попросил перенос строки, нельзя.
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) return

    const sid = keyTargetSessionId()
    if (!sid) return
    const pane = panes.get(sid)
    if (!pane) return

    const overlayOpen = overlayOwnsKeys()
    if (e.key === 'Escape') {
      if (pane.onEscape?.({ overlayOpen })) e.preventDefault()
      return
    }
    if (overlayOpen) return
    if (pane.onEnter?.(e)) e.preventDefault()
  }
  window.addEventListener('keydown', onKey)
  return () => {
    window.removeEventListener('keydown', onKey)
    installed = false
  }
}

/** Для тестов: очистить регистрации. */
export function _resetPaneKeys(): void {
  panes.clear()
}
