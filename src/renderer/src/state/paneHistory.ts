/**
 * История строки ввода (↑/↓, как в оболочке) — СВОЯ у каждой панели.
 *
 * Была одна на окно. С несколькими панелями это значило, что ↑ в панели проекта
 * Y достаёт `rm -rf dist && npm ci`, выполненную в панели проекта X, — и Enter
 * запускает её в чужой папке, без единого намёка на то, откуда взялась команда.
 *
 * Карта на уровне модуля, а не состояние: строка ввода перемонтируется вместе с
 * сырым режимом (vim, htop), а история жеста это переживать обязана.
 */
const histories = new Map<string, string[]>()

export function paneHistory(sessionId: string | null | undefined): string[] {
  const key = sessionId ?? '<окно>'
  let list = histories.get(key)
  if (!list) {
    list = []
    histories.set(key, list)
  }
  return list
}

export function pushPaneHistory(sessionId: string | null | undefined, text: string): void {
  const t = text.trim()
  const list = paneHistory(sessionId)
  if (!t || list[list.length - 1] === t) return
  list.push(t)
  if (list.length > 200) list.shift()
}

/** Панель закрылась — её история больше никому не нужна. */
export function forgetPaneHistory(sessionId: string): void {
  histories.delete(sessionId)
}
