import { useAiStore } from '@/features/ai/aiStore'
import { nextGate } from '@/features/ai/gates'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { paneDraft } from '@/state/paneDrafts'
import { paneIsRunning, paneRunningCommand } from '@/terminal/paneSignal'
import { getSettings } from '@/state/settingsStore'
import { t } from '@/lib/i18n'
import { maximizedIn, setMaximized, useUiStore } from '@/state/uiStore'

/** Короткая цитата из строки ввода — чтобы в вопросе было видно, чем рискуешь. */
function quote(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 80 ? `${one.slice(0, 80)}…` : one
}

/**
 * Что пропадёт вместе с панелью, если закрыть её прямо сейчас.
 *
 * Вложения и приписка в очереди уходят молча — они на экране, и человек
 * закрывает панель, глядя на них. Спрашиваем про то, чего с закрытой панелью
 * уже не увидеть: недописанный текст в строке и решение, которого ждёт агент.
 */
function lossesOf(sessionId: string): string[] {
  const out: string[] = []
  /*
   * Работающая команда — первая в списке потерь, потому что она единственная
   * здесь принадлежит не Заре, а операционной системе: сборку, миграцию или
   * `rsync` перезапустить дороже, чем дописать оборванную фразу.
   *
   * Настройка «Подтверждать закрытие при работающем процессе» до этого дня
   * существовала только на экране: тумблер стоял в настройках, а читать его было
   * некому. Здесь он наконец получает смысл.
   */
  if (getSettings().terminal.confirmCloseRunning && paneIsRunning(sessionId)) {
    const cmd = paneRunningCommand(sessionId).trim()
    out.push(cmd ? t('close.running', { text: quote(cmd) }) : t('close.runningPlain'))
  }
  const draft = paneDraft(sessionId).trim()
  if (draft) out.push(t('close.draft', { text: quote(draft) }))
  const ai = useAiStore.getState()
  // Беседы ВСЕ, а не последняя: чип «недавние сессии» заводит вторую, и гейт
  // первой иначе оставался бы неупомянутым — а гасить его всё равно придётся.
  const convs = ai.conversations.filter((c) => c.sessionId === sessionId)
  if (convs.some((c) => nextGate(c))) {
    out.push(t('close.gate'))
  } else if (convs.some((c) => c.streaming)) {
    out.push(t('close.streaming'))
  }
  // Вложения и приписка в очереди у ВИДИМОЙ панели молчат намеренно: они на
  // экране, и человек закрывает панель, глядя на них. У невидимой этот довод не
  // работает — про неё и говорим.
  if (!isOnScreen(sessionId)) {
    const images = ai.pendingImages[sessionId]?.length ?? 0
    if (images) out.push(t('close.images', { n: images }))
    const queued = convs.find((c) => c.queued)?.queued
    if (queued) out.push(t('close.queued', { text: quote(queued) }))
  }
  return out
}

/** Видно ли панель прямо сейчас: своя вкладка активна и разворот её не прячет. */
function isOnScreen(sessionId: string): boolean {
  const store = useSessionsStore.getState()
  const tab = store.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
  if (!tab || tab.id !== store.activeTabId) return false
  const maxed = maximizedIn(useUiStore.getState(), tab.id)
  return !maxed || maxed === sessionId
}

/**
 * Закрыть панель, спросив, если вместе с ней что-то теряется.
 *
 * Это ЕДИНСТВЕННЫЙ путь закрытия панели из интерфейса: крестик в сайдбаре,
 * пункт меню, горячая клавиша, кнопка на карточке завершённого процесса. Голый
 * `closeSession` остаётся внутренним — иначе следующая кнопка снова выбросит
 * недописанный запрос молча.
 */
/**
 * Что уже закрывается. `window.confirm` блокирует рендерер, и второй щелчок по
 * крестику (привычка двойного клика на Windows) ждал в очереди событий: ответив
 * на первый вопрос, человек получал ТОТ ЖЕ вопрос второй раз, а закрытие уходило
 * вторым параллельным проходом по тем же сессиям.
 */
const closing = new Set<string>()

export async function closePaneAsking(sessionId: string): Promise<void> {
  if (closing.has(sessionId)) return
  closing.add(sessionId)
  try {
    const losses = lossesOf(sessionId)
    if (
      losses.length &&
      !window.confirm(
        `${t('close.paneQuestion')}\n\n${t('close.willLose')}\n· ${losses.join('\n· ')}`
      )
    ) {
      return
    }
    await useSessionsStore.getState().closeSession(sessionId)
  } finally {
    closing.delete(sessionId)
  }
}

/** Закрыть вкладку целиком, спросив про потери в любой из её панелей. */
export async function closeTabAsking(tabId: string): Promise<void> {
  if (closing.has(tabId)) return
  closing.add(tabId)
  try {
    const store = useSessionsStore.getState()
    const tab = store.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const leaves = listLeaves(tab.layout)
    const losses = leaves.flatMap((sid) => lossesOf(sid))
    if (losses.length) {
      const head =
        leaves.length > 1 ? t('close.tabQuestion', { n: leaves.length }) : t('close.paneQuestion')
      if (!window.confirm(`${head}\n\n${t('close.willLose')}\n· ${losses.join('\n· ')}`)) return
    }
    await store.closeTab(tabId)
  } finally {
    closing.delete(tabId)
  }
}

/**
 * Развернуть панель на всю вкладку / вернуть сетку. Дешёвая замена «увеличить»:
 * панели соседей остаются смонтированными, поэтому возврат ничего не теряет.
 *
 * Разворачиваемая панель обязательно становится активной. Иначе получалось
 * расхождение: на экране одна панель, а Enter и Esc адресованы другой, которой
 * не видно, — и одобрение запуска команды уходило вслепую.
 */
export function toggleMaximizePane(sessionId: string): void {
  const store = useSessionsStore.getState()
  const tab = store.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
  if (!tab) return
  if (maximizedIn(useUiStore.getState(), tab.id) === sessionId) {
    setMaximized(tab.id, null)
    return
  }
  // Порядок важен: сперва фокус (он же примирит чужой разворот этой вкладки),
  // потом разворот именно этой панели.
  store.setActiveSession(sessionId)
  setMaximized(tab.id, sessionId)
}

/**
 * Развернуть/свернуть ЯВНО, без «переключить».
 *
 * Нужен строке сайдбара: двойной клик — это click, click, dblclick, и первый же
 * click делает панель активной, а вместе с этим переносит на неё разворот
 * соседа. К моменту dblclick «переключить» видело бы панель уже развёрнутой и
 * сворачивало её — жест «разверни эту» давал сетку. Намерение считается по
 * состоянию ДО жеста, поэтому здесь его задают, а не выводят.
 */
export function setPaneMaximized(sessionId: string, on: boolean): void {
  const store = useSessionsStore.getState()
  const tab = store.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
  if (!tab) return
  if (!on) {
    setMaximized(tab.id, null)
    return
  }
  store.setActiveSession(sessionId)
  setMaximized(tab.id, sessionId)
}

/** Развёрнута ли панель своей вкладки — для строк сайдбара и шапки панели. */
export function isMaximized(sessionId: string): boolean {
  const store = useSessionsStore.getState()
  const tab = store.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
  return !!tab && maximizedIn(useUiStore.getState(), tab.id) === sessionId
}

// Прогонам: закрытие ИМЕННО тем путём, которым закрывает человек — с вопросом о
// потерях. Соседний `__zaryaCloseSession` закрывает молча и для проверки самого
// вопроса не годится.
;(
  window as unknown as { __zaryaClosePaneAsking?: (sid: string) => Promise<void> }
).__zaryaClosePaneAsking = (sid) => closePaneAsking(sid)
