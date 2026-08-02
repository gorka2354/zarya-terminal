import { useSessionsStore } from '@/state/sessionsStore'
import { isRaw, useUiStore } from '@/state/uiStore'
import { askOwnsKeys } from '@/components/AskText'

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
 * хроника, командная строка, окно «введите имя». В сыром режиме терминала
 * клавиши принадлежат программе внутри него.
 *
 * Окно вопроса попало сюда не для порядка. Пока фокус стоял в его ПОЛЕ, Enter
 * до окна не доходил; но стоило перевести фокус на кнопку «Сохранить» (Tab —
 * обычный способ), и нажатие уходило дальше: кнопка срабатывала, а этот
 * диспетчер тем же событием одобрял ожидающий гейт в активной панели. То есть
 * переименование сессии запускало команду, которую человек ещё не читал.
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
    askOwnsKeys() ||
    isRaw(ui, keyTargetSessionId())
  )
}

/**
 * Курсор стоит в поле, которое НЕ принадлежит адресуемой панели.
 *
 * Строка ввода своей панели — не «чужое поле»: там Esc и должен работать. А вот
 * поиск сессий, переименование, поле настроек — чужие: нажатие в них означает
 * «закончить здесь», а не «прервать агента в панели, на которую я не смотрю».
 */
function inForeignField(sessionId: string): boolean {
  const ae = document.activeElement as HTMLElement | null
  if (!ae) return false
  const isField = ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable
  if (!isField) return false
  const pane = ae.closest('.zy-pane')
  if (pane?.getAttribute('data-session') !== sessionId) return true
  // Внутри своей панели «своими» считаются только строка ввода и сам терминал.
  // Поиск по терминалу — отдельное поле со своим Esc: он закрывает поиск, и
  // отклонять заодно ожидающий гейт ему нечего.
  return !ae.classList.contains('zy-agentbar-input') && !ae.closest('.zy-term')
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
      // Esc из ЧУЖОГО поля ввода панели не адресуется. Иначе Esc, которым
      // бросают поиск сессий в сайдбаре, прерывал ход агента в активной панели
      // и мог забрать отправленное сообщение из памяти Claude Code — человек
      // при этом смотрел совсем в другое место. Диктовка выше этой проверки:
      // она разбирается внутри панели (микрофон открыт прямо сейчас).
      if (inForeignField(sid)) {
        if (pane.onEscape?.({ overlayOpen: true })) e.preventDefault()
        return
      }
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
