/**
 * Сигналы панели: то, чем терминал останавливает программу.
 *
 * В сыром режиме этим занимается сам xterm — клавиша уходит в pty как есть. В
 * блочном режиме печатают не в терминал, а в строку ввода, и раньше Ctrl+C там
 * не значил ничего: запущенный `npm run dev` прервать было нечем, пока человек
 * не догадается щёлкнуть в терминал. Модуль закрывает именно этот разрыв —
 * строка ввода умеет то же, что и терминал под ней.
 */
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { getTerminal } from './terminalRegistry'

/** Ctrl+C — «остановись» текущей программе. */
export const ETX = '\x03'
/** Ctrl+D — «ввод закончился». */
export const EOT = '\x04'

/**
 * Идёт ли в панели команда прямо сейчас.
 *
 * Опирается на shell-интеграцию (`OSC 133;C`/`D`). Без неё оболочка о команде не
 * сообщает — тогда честный ответ «не знаю», и он же `false`: см. `BlockEngine.running`.
 */
export function paneIsRunning(sessionId: string): boolean {
  /*
   * Мёртвой панели живой команды не бывает.
   *
   * Фаза движка снимается только отметкой `OSC 133;D`, а её некому прислать,
   * если оболочка ушла: `exit`, падение процесса, закрытая ssh-сессия — фаза
   * навсегда остаётся «идёт». Панель с карточкой «процесс завершён» спрашивала
   * бы при закрытии «команда „exit“ будет прервана» — вопрос о том, чего нет.
   */
  if (useSessionsStore.getState().sessions[sessionId]?.status !== 'running') return false
  return getTerminal(sessionId)?.engine.running ?? false
}

/**
 * Команда, которая идёт в панели, — чтобы вопрос называл предмет.
 *
 * Имя берём из ленты блоков, а не из внутреннего поля движка: человек читает
 * команду именно там, и вопрос обязан назвать ровно то, что он видит. Заодно это
 * снимает зависимость от того, каким из протоколов оболочка сообщила командную
 * строку. Пусто — оболочка её не назвала; тогда и вопрос обойдётся без имени.
 */
export function paneRunningCommand(sessionId: string): string {
  const engineName = getTerminal(sessionId)?.engine.runningCommand
  if (engineName) return engineName
  const blocks = useBlocksStore.getState().bySession[sessionId] ?? []
  const last = blocks[blocks.length - 1]
  return last && last.exitCode === undefined ? last.command : ''
}

/**
 * Отправить сигнал прерывания в оболочку панели.
 *
 * Отправляем всегда, когда человек попросил, а не только при известной нам
 * команде: без shell-интеграции мы не знаем, что там идёт, а Ctrl+C по пустому
 * приглашению — привычная отмена набранной строки, и оболочка сама отрисует
 * `^C`. Промолчать здесь было бы хуже: клавиша, которая иногда работает,
 * приучает не доверять ей вовсе.
 */
export function interruptPane(sessionId: string): void {
  if (!sessionId) return
  window.zarya.pty.write(sessionId, ETX)
}
