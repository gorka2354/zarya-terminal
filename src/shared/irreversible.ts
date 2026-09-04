/**
 * Команды, после которых нет пути назад, — ПОДПИСЬ на карточке разрешения.
 *
 * Что это НЕ ТАКОЕ, важнее того, что это такое. Это не песочница и не защита:
 * у Зари нет изоляции операционной системы, и `rm -rf` через переменную, алиас
 * или внутри скрипта сюда не попадёт. Обещать защиту механизмом, который её не
 * даёт, — ровно та неправда, за которую мы ругаем чужие интерфейсы.
 *
 * ЭТО БЫЛ «ПОЛ ПОД АВТОПИЛОТОМ»: такие команды показывались даже при выключенных
 * гейтах. От пола отказались осознанно — решение владельца, 2026-09-04. Довод:
 * тумблер, который иногда всё-таки спрашивает, хуже обоих честных состояний, а
 * пол всё равно ловил лишь дословную форму команды и не был защитой. Теперь
 * автопилот означает автопилот, и подпись чипа («выполняет все инструменты сам,
 * без подтверждений») стала правдой без оговорок.
 *
 * Признак остался и работает там, где гейты ВКЛЮЧЕНЫ: человек читает не просто
 * команду, а команду с пометкой «это не отменить», — и решает, зная это.
 *
 * Правило отбора прежнее: попадает только то, после чего НЕТ пути назад. Поэтому
 * здесь нет `git reset --hard` (коммиты достаются из reflog) и нет `chmod`
 * (права возвращаются), но есть удаление рекурсией и запись в устройство.
 */

export type IrreversibleKind =
  'delete' | 'force-push' | 'drop' | 'device' | 'wipe' | 'clean' | 'history'

export interface Irreversible {
  kind: IrreversibleKind
  /** Кусок команды, из-за которого сработало, — показывается человеку. */
  hit: string
}

interface Rule {
  kind: IrreversibleKind
  re: RegExp
}

const RULES: Rule[] = [
  // Удаление рекурсией без спроса: `rm -rf`, `rm -fr`, `rm -r --force`,
  // `rm --force -r`. Два независимых просмотра вперёд — «рекурсия» и «не
  // спрашивать» — ловят любой порядок и оба стиля флагов. Одна регулярка на
  // «rf» пропускала `rm -r --force`, а это самый обычный вид этой команды в
  // чужих скриптах. При этом `rm -r empty_dir` и `rm -f file` проходят молча:
  // поодиночке они не настолько необратимы, чтобы будить человека.
  {
    kind: 'delete',
    re: /\brm\b(?=[^|;&]*(?:\s-[a-z]*r|--recursive))(?=[^|;&]*(?:\s-[a-z]*f|--force))/i
  },
  {
    kind: 'delete',
    re: /\bremove-item\b[^|;&]*-recurse[^|;&]*-force|\bremove-item\b[^|;&]*-force[^|;&]*-recurse/i
  },
  { kind: 'delete', re: /\brmdir\b[^|;&]*\s\/s\b/i },

  // Перезапись чужой истории в общем репозитории.
  { kind: 'force-push', re: /\bgit\b[^|;&]*\bpush\b[^|;&]*(--force\b(?!-with-lease)|\s-f\b)/i },

  // Снос данных в базе.
  { kind: 'drop', re: /\bdrop\s+(table|database|schema|index)\b/i },
  { kind: 'drop', re: /\btruncate\s+table\b/i },

  // Запись мимо файловой системы — прямо в устройство.
  { kind: 'device', re: /\bdd\b[^|;&]*\bof=\/dev\//i },
  { kind: 'device', re: />\s*\/dev\/(sd|nvme|disk|hd)/i },

  // Форматирование и затирание.
  { kind: 'wipe', re: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { kind: 'wipe', re: /\bshred\b/i },
  { kind: 'wipe', re: /\bformat\s+[a-z]:/i },
  { kind: 'wipe', re: /\bdiskpart\b/i },

  // Удаление того, что не в git: `git clean -fdx` уносит и .env, и локальные
  // сборки, и всё, что не закоммичено.
  { kind: 'clean', re: /\bgit\b[^|;&]*\bclean\b[^|;&]*-[a-z]*f/i },

  // Переписывание истории репозитория целиком.
  { kind: 'history', re: /\bgit\b[^|;&]*\b(filter-branch|filter-repo)\b/i },
  { kind: 'history', re: /\bgit\b[^|;&]*\breflog\b[^|;&]*\bexpire\b/i },
  { kind: 'history', re: /\bgit\b[^|;&]*\bgc\b[^|;&]*--prune=now/i }
]

/** Достать строку команды из входа инструмента — форма зависит от движка. */
function commandOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script', 'input', 'text']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/**
 * Попадает ли вызов инструмента под пол.
 *
 * Смотрим только на команды оболочки: правки файлов сюда не относятся — их
 * видно в диффе и можно вернуть, а вот выполненное `rm -rf` вернуть нельзя.
 */
export function irreversible(toolName: string, input: unknown): Irreversible | null {
  const tool = toolName.toLowerCase()
  const shellish = ['bash', 'run_command', 'shell', 'execute', 'terminal', 'powershell', 'cmd']
  if (!shellish.some((x) => tool.includes(x))) return null
  const cmd = commandOf(input)
  if (!cmd.trim()) return null
  for (const r of RULES) {
    const m = r.re.exec(cmd)
    // Показываем КУСОК КОМАНДЫ с места срабатывания, а не само совпадение:
    // правила с просмотром вперёд совпадают только на «rm», и человек увидел бы
    // подпись «rm» под командой `rm -rf build` — то есть меньше, чем знает сам.
    if (m) return { kind: r.kind, hit: cmd.slice(m.index, m.index + 60).trim() }
  }
  return null
}
