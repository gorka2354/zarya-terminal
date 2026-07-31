import { create } from 'zustand'

/**
 * Микрофон один на машину — значит и замок один на приложение.
 *
 * Пока строка ввода была одна, конфликта не существовало. С несколькими
 * панелями (inc-17) кнопка «говорить» есть у каждой, а защита от повторного
 * запуска сидела ВНУТРИ строки: четыре строки — четыре независимые защиты, все
 * проходят одновременно. Получилось бы четыре записи одной фразы, четыре
 * локальных расшифровки (вчетверо больше нагрузки на процессор ради худшего
 * результата) и текст, вставленный в четыре разные строки — из трёх его пришлось
 * бы вычищать руками.
 *
 * Перехвата нет намеренно. «Переезжает при нажатии в другой панели» звучит
 * удобно, но обрывает фразу на полуслове, и первая панель молча получает
 * огрызок. Один человек — один голос: две панели одновременно диктовать
 * физически не могут, поэтому конфликт здесь всегда случайный (промах мышью), и
 * честный отказ лучше тихой подмены.
 *
 * Получатель фиксируется в момент старта: текст придёт в ту панель, где нажали,
 * даже если за время фразы человек щёлкнул в другую. Иначе вышла бы та же
 * болезнь, что была с Enter, — результат уезжает не туда, куда смотрели.
 */
interface MicLockState {
  /** Панель, которая сейчас держит микрофон. null — свободен. */
  owner: string | null
  set: (owner: string | null) => void
}

const useMicLock = create<MicLockState>((set) => ({
  owner: null,
  set: (owner) => set({ owner })
}))

/** Занять микрофон. false — уже занят другой панелью, запись начинать нельзя. */
export function claimMic(sessionId: string): boolean {
  const { owner } = useMicLock.getState()
  if (owner && owner !== sessionId) return false
  useMicLock.getState().set(sessionId)
  return true
}

/** Отпустить — только своя панель, чтобы чужой cleanup не открыл микрофон другим. */
export function releaseMic(sessionId: string | null | undefined): void {
  if (!sessionId) return
  if (useMicLock.getState().owner === sessionId) useMicLock.getState().set(null)
}

/** Кто держит микрофон (для подписи на кнопке и индикатора в панели-получателе). */
export function micOwner(): string | null {
  return useMicLock.getState().owner
}

/** Реактивно: занят ли микрофон ДРУГОЙ панелью — кнопка обязана это показывать. */
export function useMicBusyElsewhere(sessionId: string | null | undefined): boolean {
  return useMicLock((s) => !!s.owner && s.owner !== sessionId)
}

/** Для тестов и полной уборки. */
export function _resetMicLock(): void {
  useMicLock.getState().set(null)
}
