import { getTerminal } from './terminalRegistry'

/**
 * Поставить курсор В ПАНЕЛЬ — туда, где в ней можно печатать.
 *
 * Это строка ввода, а не терминал. Разница не косметическая: гейт одобряет
 * ГОЛЫЙ Enter и только когда курсор не в чужом поле (features/ai/keyRouter).
 * Скрытое поле xterm — тоже поле, и фокус в нём означал бы, что панель в фокусе,
 * рамка на месте, а Enter не одобряет ничего. В сыром режиме строки нет — там
 * печатают прямо в терминал, туда курсор и уходит.
 */
export function focusPane(sessionId: string): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      `.zy-pane[data-session="${CSS.escape(sessionId)}"] .zy-agentbar-input`
    )
    if (input) input.focus()
    else getTerminal(sessionId)?.focus()
  })
}
