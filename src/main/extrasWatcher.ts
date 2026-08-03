import { watch, type FSWatcher } from 'fs'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Следит за тем, откуда агент берёт скиллы, команды, плагины и MCP-серверы.
 *
 * Зачем. Поставил MCP-сервер или скилл — и агент просит перезапустить сессию,
 * то есть предлагает потерять разговор и начать сначала. Перезапуск при этом не
 * нужен: живая сессия умеет перечитать диск (см. reloadExtras). Но чтобы это
 * помогло, кто-то должен ЗАМЕТИТЬ, что на диске появилось новое, — иначе
 * человек по-прежнему обязан помнить про кнопку.
 *
 * Что здесь НЕ делается: перечитывание само. Наблюдатель только говорит «на
 * диске что-то изменилось»; решение принимает человек. Молча менять состав
 * инструментов у работающего агента — значит менять правила игры посреди хода.
 */

/** Места, где живут скиллы, команды, плагины и настройки MCP. */
function placesFor(cwd: string): string[] {
  const home = homedir()
  return [
    join(cwd, '.claude', 'skills'),
    join(cwd, '.claude', 'commands'),
    join(cwd, '.claude', 'plugins'),
    join(cwd, '.mcp.json'),
    join(home, '.claude', 'skills'),
    join(home, '.claude', 'commands'),
    join(home, '.claude', 'plugins')
  ]
}

/** Файлы, которые действительно что-то значат для состава инструментов. */
function meaningful(name: string): boolean {
  if (!name) return true // событие без имени — считаем значимым, проверит reload
  const n = name.toLowerCase()
  if (n.endsWith('.tmp') || n.endsWith('~') || n.startsWith('.git')) return false
  return n.endsWith('.md') || n.endsWith('.json') || n.endsWith('.toml') || !n.includes('.')
}

export class ExtrasWatcher {
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | undefined
  private watchedCwd = ''

  /**
   * Начать следить за папками проекта и пользователя.
   *
   * `onChange` вызывается НЕ на каждое событие файловой системы: установка
   * одного скилла — это десяток записей подряд, и дёргать окно десять раз
   * значит превратить подсказку в мигание. Пауза в полторы секунды собирает
   * их в одно сообщение.
   */
  start(cwd: string, onChange: () => void): void {
    if (cwd && cwd === this.watchedCwd && this.watchers.length) return
    this.stop()
    this.watchedCwd = cwd
    for (const place of placesFor(cwd)) {
      if (!existsSync(place)) continue
      try {
        const w = watch(place, { recursive: true }, (_ev, name) => {
          if (!meaningful(typeof name === 'string' ? name : '')) return
          clearTimeout(this.timer)
          this.timer = setTimeout(onChange, 1500)
        })
        // Наблюдатель за чужой папкой не должен ронять приложение: домашний
        // каталог могут перемонтировать, а проектный — удалить прямо во время
        // работы.
        w.on('error', () => {
          /* место стало недоступно — просто перестаём за ним следить */
        })
        this.watchers.push(w)
      } catch {
        /* нет прав или путь исчез — молча пропускаем это место */
      }
    }
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        /* уже закрыт */
      }
    }
    this.watchers = []
    this.watchedCwd = ''
  }
}
