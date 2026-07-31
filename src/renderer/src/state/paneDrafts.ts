/**
 * Ненабранное: что стоит в строке ввода панели, но ещё не отправлено.
 *
 * Строка ввода держит текст в своём состоянии — и это правильно, набор не должен
 * гонять стор на каждую букву. Но закрытие панели приходит СНАРУЖИ (крестик в
 * сайдбаре, пункт меню), и оно обязано знать, теряется ли при этом текст:
 * молча выбросить недописанный запрос агенту — то же самое, что закрыть
 * редактор без вопроса о несохранённом файле.
 *
 * Поэтому строка ввода отзеркаливает свой текст сюда. Карта, а не стор: подписок
 * на неё нет, перерисовок от неё не бывает.
 */
const drafts = new Map<string, string>()

export function setPaneDraft(sessionId: string | null | undefined, text: string): void {
  if (!sessionId) return
  if (text) drafts.set(sessionId, text)
  else drafts.delete(sessionId)
}

/** Текст в строке этой панели; пусто — терять нечего. */
export function paneDraft(sessionId: string | null | undefined): string {
  return (sessionId && drafts.get(sessionId)) || ''
}

export function forgetPaneDraft(sessionId: string): void {
  drafts.delete(sessionId)
}
