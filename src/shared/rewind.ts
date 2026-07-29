import type { AgentRewind } from './types'

/**
 * Отмена ОТПРАВЛЕННОГО сообщения: куда продолжать беседу.
 *
 * Правило одно и то же для всех драйверов, поэтому живёт здесь, а не в каждом.
 * Продолжить можно только с ОТВЕТА агента — так устроен `resumeSessionAt` в
 * Agent SDK (и так же ведёт себя настоящий CLI: он не удаляет запись, а
 * продолжает от родителя отменённой).
 *
 * Разбор случаев:
 *
 * - агент в этой сессии уже отвечал → ветка от его последнего ответа;
 * - не отвечал, но сама сессия — ветка → отматываем к той же точке, откуда она
 *   началась (это два Esc подряд: отменил, переписал, снова отменил);
 * - не отвечал, а история есть (сессия продолжена с диска) → точки отмотки у нас
 *   нет. Начать заново — потерять беседу, продолжить молча — вернуть отменённое
 *   в контекст. Обе неправды, поэтому `null`: пусть остаётся пометка «прервано»;
 * - не отвечал и истории нет → терять нечего, следующий ход начнёт сессию с нуля.
 */
export interface RewindState {
  /** UUID последнего ответа агента В ЭТОМ процессе (точка для resumeSessionAt). */
  lastAssistantUuid?: string
  /** Id живой сессии (из init). */
  sessionId?: string
  /** Точка, от которой эта сессия сама была отмотана. */
  forkBase?: { sessionId: string; at: string }
  /** Сессия продолжает прежнюю историю (`resume`), а не начата с нуля. */
  resumed: boolean
}

export function rewindPoint(s: RewindState): AgentRewind | null {
  if (s.lastAssistantUuid && s.sessionId)
    return { kind: 'fork', sessionId: s.sessionId, at: s.lastAssistantUuid }
  if (s.forkBase) return { kind: 'fork', sessionId: s.forkBase.sessionId, at: s.forkBase.at }
  return s.resumed ? null : { kind: 'fresh' }
}
