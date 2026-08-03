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
 * За чем следим. Личные скиллы лежат в домашней папке и одни на все панели, а
 * проектные (`.claude/skills`, `.mcp.json`) — рядом с кодом, и у каждой панели
 * свои. Раньше здесь стояла папка ПРОЦЕССА — то есть та, из которой запустили
 * приложение: домашние скиллы это ловило, а проектные не видело вообще, включая
 * `.mcp.json` открытого проекта. Теперь папки приходят от самих бесед.
 *
 * Что здесь НЕ делается: перечитывание само. Наблюдатель только говорит «на
 * диске что-то изменилось»; решение принимает человек. Молча менять состав
 * инструментов у работающего агента — значит менять правила игры посреди хода.
 */

/** Личные места: одни на все панели. */
function homePlaces(): string[] {
  const home = homedir()
  return [
    join(home, '.claude', 'skills'),
    join(home, '.claude', 'commands'),
    join(home, '.claude', 'plugins')
  ]
}

/** Места проекта: у каждой панели свои. */
function projectPlaces(cwd: string): string[] {
  return [
    join(cwd, '.claude', 'skills'),
    join(cwd, '.claude', 'commands'),
    join(cwd, '.claude', 'plugins'),
    join(cwd, '.mcp.json')
  ]
}

/** Файлы, которые действительно что-то значат для состава инструментов. */
function meaningful(name: string): boolean {
  if (!name) return true // событие без имени — считаем значимым, проверит reload
  const n = name.toLowerCase()
  if (n.endsWith('.tmp') || n.endsWith('~') || n.startsWith('.git')) return false
  return n.endsWith('.md') || n.endsWith('.json') || n.endsWith('.toml') || !n.includes('.')
}

/**
 * Сколько папок проектов держим под наблюдением.
 *
 * Панелей одновременно не больше четырёх, но за день человек открывает десятки
 * проектов, и каждый оставил бы за собой пару дескрипторов. Держим последние
 * шесть — этого хватает на все живые панели с запасом, а остальное закрываем.
 */
const MAX_PROJECTS = 6

export class ExtrasWatcher {
  private home: FSWatcher[] = []
  private byProject = new Map<string, FSWatcher[]>()
  private timer: NodeJS.Timeout | undefined
  private onChange: (() => void) | undefined

  /**
   * Начать следить за личными папками и за папкой ОДНОЙ беседы.
   *
   * Вызывается каждый раз, когда панель заговорила с агентом: домашние места
   * заводятся один раз, папка проекта — при первом упоминании. Повторный вызов
   * с той же папкой ничего не делает.
   *
   * `onChange` вызывается НЕ на каждое событие файловой системы: установка
   * одного скилла — это десяток записей подряд, и дёргать окно десять раз
   * значит превратить подсказку в мигание. Пауза в полторы секунды собирает
   * их в одно сообщение.
   */
  watch(cwd: string | undefined, onChange: () => void): void {
    this.onChange = onChange
    if (!this.home.length) this.home = this.arm(homePlaces())
    if (!cwd || this.byProject.has(cwd)) return
    const watchers = this.arm(projectPlaces(cwd))
    // Пустой список тоже помним: иначе каждый вызов заново проверял бы диск на
    // папке, где ничего из этого нет.
    this.byProject.set(cwd, watchers)
    while (this.byProject.size > MAX_PROJECTS) {
      const oldest = this.byProject.keys().next().value
      if (oldest === undefined) break
      this.close(this.byProject.get(oldest))
      this.byProject.delete(oldest)
    }
  }

  private arm(places: string[]): FSWatcher[] {
    const out: FSWatcher[] = []
    for (const place of places) {
      if (!existsSync(place)) continue
      try {
        const w = watch(place, { recursive: true }, (_ev, name) => {
          if (!meaningful(typeof name === 'string' ? name : '')) return
          clearTimeout(this.timer)
          this.timer = setTimeout(() => this.onChange?.(), 1500)
        })
        // Наблюдатель за чужой папкой не должен ронять приложение: домашний
        // каталог могут перемонтировать, а проектный — удалить прямо во время
        // работы.
        w.on('error', () => {
          /* место стало недоступно — просто перестаём за ним следить */
        })
        out.push(w)
      } catch {
        /* нет прав или путь исчез — молча пропускаем это место */
      }
    }
    return out
  }

  private close(ws: FSWatcher[] | undefined): void {
    for (const w of ws ?? []) {
      try {
        w.close()
      } catch {
        /* уже закрыт */
      }
    }
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.onChange = undefined
    this.close(this.home)
    this.home = []
    for (const ws of this.byProject.values()) this.close(ws)
    this.byProject.clear()
  }
}
