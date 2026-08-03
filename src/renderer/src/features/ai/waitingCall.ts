import { attentionOf, useAiStore } from './aiStore'
import { t } from '@/lib/i18n'

/**
 * Позвать человека, когда агент встал и ждёт решения.
 *
 * Восьмичасовой день без этого выглядит так: отправил задачу, ушёл в браузер,
 * вернулся через десять минут — и девять из них агент ждал одного нажатия.
 * Панель об этом говорит (пульсирующая рамка, счётчик в сайдбаре), но только
 * тому, кто на неё смотрит.
 *
 * Три правила, без которых зов превращается в шум, а шум выключают вместе с
 * сигналом:
 *
 * 1. Только когда окно НЕ в фокусе. Сообщать о том, что и так на экране, —
 *    худший способ потратить доверие к уведомлениям.
 * 2. Только на ПЕРЕХОД в ожидание. Гейт висит минутами; звать надо один раз,
 *    когда он появился, а не каждую перерисовку.
 * 3. Только по фактическим гейтам (attentionOf), без догадок по выводу.
 */

/** Что мы уже отзвонили: id беседы → id гейта, о котором звали. */
const called = new Map<string, string>()

/** Первый нерешённый гейт беседы — по нему и опознаём «тот же самый». */
function pendingId(convId: string): string | null {
  const conv = useAiStore.getState().conversations.find((c) => c.id === convId)
  if (!conv) return null
  return conv.pendingTools.find((x) => !x.settled)?.id ?? null
}

export function installWaitingCall(): () => void {
  const unsub = useAiStore.subscribe((state) => {
    // Окно в фокусе — человек здесь, звать некуда.
    if (typeof document !== 'undefined' && document.hasFocus()) {
      // Заодно забываем отзвоненное: вернувшись, человек увидел всё сам, и
      // следующий гейт должен позвать заново.
      called.clear()
      return
    }
    for (const conv of state.conversations) {
      const waiting = attentionOf(conv) === 'waiting'
      const gate = waiting ? pendingId(conv.id) : null
      if (!gate) {
        called.delete(conv.id)
        continue
      }
      if (called.get(conv.id) === gate) continue
      called.set(conv.id, gate)
      const tool = conv.pendingTools.find((x) => !x.settled)
      window.zarya.app.notifyWaiting(
        t('notify.waitingTitle'),
        // Имя панели и что именно спрашивают: «Заря ждёт» без подробностей
        // заставляет открыть окно, чтобы узнать, стоило ли открывать.
        t('notify.waitingBody', {
          pane: conv.title,
          tool: tool?.displayName || tool?.title || tool?.name || ''
        })
      )
    }
  })
  return () => {
    unsub()
    called.clear()
  }
}
