import { t } from '@/lib/i18n'
import { getTerminal } from '@/terminal/terminalRegistry'

/**
 * Отправка блока кода из ответа агента в терминал.
 *
 * ОДНА функция на оба места, где такая кнопка есть, — лента панели и боковая
 * панель. Раньше это были две копии одного обработчика, и они молча разошлись:
 * в панели стояло подтверждение на многострочный код, а в ленте его не было
 * вовсе. Значит «Вставить» в ленте ИСПОЛНЯЛО чужой код — внутренние переводы
 * строк оболочка принимает за Enter, и первая строка запускалась ещё до того,
 * как человек успевал её прочитать.
 *
 * Почему это важно: код в ленте пишет агент, а он читает файлы открытого
 * проекта — README, комментарии, ответы MCP-серверов. Подсунуть туда блок с
 * `curl … | sh` первой строкой и безобидным `npm test` второй может кто угодно,
 * чей репозиторий человек открыл.
 *
 * «Вставить» обязано именно ВСТАВЛЯТЬ: хвостовой перевод строки снимается, а на
 * многострочный кусок спрашиваем — ровно один раз и с числом строк, чтобы
 * человек видел, что отправляет больше, чем читает.
 */
export function sendCodeToTerminal(
  sessionId: string,
  code: string,
  action: 'insert' | 'run'
): void {
  if (!sessionId || !code) return
  if (action === 'insert') {
    const noTrailing = code.replace(/\r?\n$/, '')
    const lines = noTrailing.split('\n').length
    if (lines > 1 && !window.confirm(t('ide.pasteAsk', { n: lines }))) return
    window.zarya.pty.write(sessionId, noTrailing)
  } else {
    const lines = code.trim().split('\n').length
    if (lines > 1 && !window.confirm(t('ide.runAsk', { n: lines }))) return
    window.zarya.pty.write(sessionId, code + '\r')
  }
  getTerminal(sessionId)?.focus()
}
