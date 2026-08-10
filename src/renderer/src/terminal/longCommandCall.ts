import { onBus } from '@/lib/bus'
import { t } from '@/lib/i18n'
import { getSettings } from '@/state/settingsStore'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'

/**
 * Позвать человека, когда долгая команда наконец закончилась.
 *
 * Сборка идёт восемь минут, человек уходит в браузер и возвращается через
 * двадцать — двенадцать из них терминал простоял с готовым ответом. Оболочка
 * знает и когда команда началась, и чем кончилась (`OSC 133;C`/`D`), Заря это
 * уже разбирает, — и до сих пор молчала.
 *
 * Правила те же, что у зова агента (см. waitingCall), и по той же причине: зов,
 * который приходит не вовремя, выключают вместе с полезным.
 *
 * 1. Только когда окно НЕ в фокусе. Сообщать о том, что и так на экране, —
 *    худший способ потратить доверие к уведомлениям.
 * 2. Только про ДОЛГИЕ команды. `ls` и `git status` заканчиваются раньше, чем
 *    человек успевает отвернуться, и звать о них — превратить уведомления в
 *    поток, который перестают читать.
 * 3. Только когда оболочка сказала, что команда закончилась. Догадок по выводу
 *    не строим: «кажется, доделалось» — это не новость, а предположение.
 */

/**
 * Короче этого не зовём.
 *
 * Полминуты — граница, за которой человек успевает переключиться на другое
 * окно. Всё, что быстрее, он дожидается глядя на экран, и уведомление приходит
 * ему в спину о том, что он уже видел.
 */
export const LONG_COMMAND_MS = 30_000

/** Команду в заголовке обрезаем: уведомление ОС длинную всё равно не покажет. */
function shortCmd(cmd: string): string {
  const one = cmd.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? `${one.slice(0, 60)}…` : one
}

export function installLongCommandCall(): () => void {
  return onBus('block:finished', ({ sessionId, blockId, exitCode }) => {
    if (!getSettings().notifications.whenLongDone) return
    // Окно в фокусе — человек здесь и всё видит сам.
    if (typeof document !== 'undefined' && document.hasFocus()) return
    const block = useBlocksStore
      .getState()
      .bySession[sessionId]?.find((b) => b.id === blockId)
    if (!block?.endedAt) return
    const ms = block.endedAt - block.startedAt
    if (ms < LONG_COMMAND_MS) return
    /*
     * Команда без имени — не новость.
     *
     * Без shell-интеграции текста команды нет, и уведомление «что-то
     * закончилось за 4 минуты» отправляет человека к окну выяснять, что
     * именно. Тогда лучше промолчать.
     */
    const cmd = shortCmd(block.command)
    if (!cmd) return
    const pane = useSessionsStore.getState().sessions[sessionId]?.title ?? ''
    const sec = Math.round(ms / 1000)
    /*
     * Код выхода — в самом сообщении, а не намёком.
     *
     * «Сборка закончилась» и «сборка упала» — две разные новости, и разница
     * между ними решает, идти к компьютеру сейчас или после кофе. Кода нет
     * (оболочка не назвала) — не выдумываем ноль: говорим без него.
     */
    const ok = exitCode === undefined || exitCode === 0
    window.zarya.app.notifyWaiting(
      t(ok ? 'notify.doneTitle' : 'notify.failTitle', { pane }),
      exitCode === undefined
        ? t('notify.doneBody', { cmd, sec })
        : t('notify.doneBodyCode', { cmd, sec, code: exitCode }),
      'done'
    )
  })
}
