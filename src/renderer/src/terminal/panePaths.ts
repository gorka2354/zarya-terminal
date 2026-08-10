/**
 * Путь файла, попадающий в строку человека: перетаскиванием в панель или в
 * строку ввода.
 *
 * Модуль общий для обоих жестов намеренно. Раньше один и тот же файл, брошенный
 * на два сантиметра выше или ниже, давал разный текст: строка ввода всегда брала
 * путь в двойные кавычки, а терминал — только при пробеле. Разное поведение у
 * одного жеста человек читает как случайность, а не как правило.
 *
 * Экранируем ВСЕГДА. Кавычки нужны не только пробелу: `&`, `|`, `;`, `(` рвут
 * командную строку не хуже, а имя файла приходит из файловой системы — то есть
 * из чужих рук (репозиторий, архив, загрузка). Путь, вставленный в приглашение,
 * человек отправляет по Enter не глядя.
 */
import { quotePath as quoteForShell } from '@shared/paths'
import { emitBus } from '@/lib/bus'
import { isRaw, useUiStore } from '@/state/uiStore'
import { getTerminal } from './terminalRegistry'

/** Кавычки под текущую систему; сами правила — в `@shared/paths`. */
export function quotePath(path: string): string {
  return quoteForShell(path, /win/i.test(navigator.platform))
}

/** Пути перетащенных файлов, готовые к вставке одной строкой. */
export function pathsFromDrop(dt: DataTransfer | null): string[] {
  if (!dt?.files?.length) return []
  const out: string[] = []
  for (const file of Array.from(dt.files)) {
    const p = window.zarya.app.getPathForFile(file)
    if (p) out.push(quotePath(p))
  }
  return out
}

/**
 * Положить пути туда, где в этой панели печатают.
 *
 * В сыром режиме это сама оболочка, в блочном — строка ввода. Ошибиться адресом
 * здесь значит потерять путь молча: в блочном режиме терминал накрыт лентой, и
 * текст, ушедший в оболочку, человек не увидит вовсе.
 */
export function insertPathsIntoPane(sessionId: string, paths: string[]): boolean {
  if (!sessionId || !paths.length) return false
  const text = paths.join(' ')
  if (isRaw(useUiStore.getState(), sessionId)) {
    const handle = getTerminal(sessionId)
    if (!handle) return false
    handle.term.paste(text)
    handle.focus()
    return true
  }
  emitBus('input:insert', { sessionId, text })
  return true
}
