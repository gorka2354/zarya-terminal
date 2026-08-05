import { irreversible } from './irreversible'

/**
 * «Разрешить до конца сессии» — середина между «спрашивать всё» и «не
 * спрашивать ничего».
 *
 * Без неё выбор такой: подтверждать `git status` по сто раз за день (и к
 * пятидесятому разу перестать читать, что в карточке) — или снять гейт целиком
 * и получить `rm -rf` без вопроса. Люди выбирают второе, потому что первое
 * невыносимо, и это худший исход из возможных.
 *
 * Главное отличие от чужих решений: правило создаёт ЧЕЛОВЕК и видит его
 * дословно. У соседей автоодобрение работает «по уверенности агента» — правило
 * есть, но его не показывают, и почему в этот раз спросили, а в прошлый нет,
 * понять нельзя.
 */

/** Правило — это точная команда или имя инструмента. Никаких шаблонов. */
export type AllowRule = string

function commandOf(input: unknown): string {
  if (typeof input === 'string') return input.trim()
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script', 'input', 'text']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Какое правило создаст «разрешить до конца сессии» для этого вызова.
 *
 * Для команд оболочки — сама команда, дословно и целиком. Соблазн обобщить
 * («разрешить все `git`») здесь и есть источник неправды: человек разрешал
 * `git status`, а получил бы заодно `git push --force`. Другая команда —
 * другое решение, даже если начало совпадает.
 *
 * Для остальных инструментов — имя: `Read`, `Edit`, `WebFetch`. Там аргумент
 * меняется каждый раз, и правило по аргументу не сработало бы ни разу.
 */
export function ruleFor(toolName: string, input: unknown): AllowRule | null {
  // Необратимое не разрешается «до конца сессии» ВООБЩЕ. Иначе пол снимался бы
  // через боковую дверь: одно нажатие — и `rm -rf` больше не спрашивают.
  if (irreversible(toolName, input)) return null
  const cmd = commandOf(input)
  const tool = toolName.trim()
  if (!tool) return null
  /*
   * Выход из режима плана «до конца сессии» не разрешается.
   *
   * Правило означало бы: впредь агент выходит из плана САМ, не спрашивая. Но
   * весь смысл режима — в том, чтобы человек увидел план и согласился с ним;
   * раздав такое разрешение один раз, он оставил бы себе чип, который больше
   * ничего не защищает. Кнопка обещала бы удобство, а забирала бы гарантию.
   */
  if (tool === 'ExitPlanMode') return null
  const shellish = ['bash', 'run_command', 'shell', 'execute', 'terminal', 'powershell', 'cmd']
  if (shellish.some((x) => tool.toLowerCase().includes(x))) {
    if (!cmd) return null
    // Многострочное не разрешаем: в такой команде легко спрятать вторую строку,
    // а человек прочитает первую.
    if (cmd.includes('\n')) return null
    return `${tool}: ${cmd}`
  }
  return tool
}

/** Подпадает ли вызов под уже созданное правило. */
export function matchesRule(rules: AllowRule[] | undefined, toolName: string, input: unknown): boolean {
  if (!rules?.length) return false
  // Пол выше правил всегда: даже если правило каким-то образом появилось,
  // необратимое всё равно спрашивают.
  if (irreversible(toolName, input)) return false
  const rule = ruleFor(toolName, input)
  return !!rule && rules.includes(rule)
}

/** Как правило выглядит в списке разрешённого. */
export function describeRule(rule: AllowRule): { tool: string; command?: string } {
  const at = rule.indexOf(': ')
  if (at < 0) return { tool: rule }
  return { tool: rule.slice(0, at), command: rule.slice(at + 2) }
}

/** Добавить правило, не плодя дублей. */
export function withRule(rules: AllowRule[] | undefined, rule: AllowRule): AllowRule[] {
  const list = rules ?? []
  return list.includes(rule) ? list : [...list, rule]
}
