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
    const pane = document.querySelector<HTMLElement>(
      `.zy-pane[data-session="${CSS.escape(sessionId)}"]`
    )
    // Порядок — по тому, чем сейчас в панели отвечают. Когда агент задал вопрос,
    // строки ввода нет вовсе: её место занимает карточка выбора, и подсказка
    // «1–9 или ↑↓ + Enter» работает, только если фокус на карточке. Курсор в
    // скрытом поле xterm убивал бы и её, и одобрение гейта голым Enter.
    const target =
      pane?.querySelector<HTMLElement>('.zy-agentbar-input') ??
      pane?.querySelector<HTMLElement>('.zy-cqb')
    if (target) target.focus()
    else getTerminal(sessionId)?.focus()
  })
}
