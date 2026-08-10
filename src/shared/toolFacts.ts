/**
 * Что инструмент сделал НА САМОМ ДЕЛЕ — из разобранного результата, а не из
 * текста, который увидела модель.
 *
 * Движок присылает рядом с текстовым итогом структурированный (`tool_use_result`):
 * там сказано, что команду прервали по таймауту, что файл прочитан не целиком,
 * что поиск нашёл вдвое больше, чем показал. В тексте этого нет — в нём ровно то,
 * что ушло модели, — и на экране успешная команда, оборванная команда и команда,
 * ушедшая в фон, выглядели одинаково: «✓ готово».
 *
 * Это тот самый род лжи, от которого Заря отказывается: не пробел, который
 * человек обойдёт, а утверждение, которому он поверит. Поэтому здесь только
 * факты, меняющие ВЫВОД: «прочитано 200 строк из 4000» решает, можно ли верить
 * заключению агента о файле, а «поиск занял 12 мс» — нет.
 *
 * Разбор чистой функцией: формы приходят из чужих типов и меняются с версией
 * SDK, а проверять их на живом движке нечем — дождаться настоящего таймаута или
 * настоящего усечения в прогоне не выйдет. Незнакомая форма даёт пустой список:
 * промолчать честнее, чем показать выдуманное число.
 */

/** Одна строка о результате: ключ словаря и подстановки к нему. */
export interface ToolFact {
  key: string
  vars?: Record<string, string | number>
  /**
   * `warn` — итог НЕПОЛНЫЙ или не тот, каким кажется: усечение, обрыв, уход в
   * фон. `info` — просто цифра, которая помогает читать карточку.
   */
  level: 'info' | 'warn'
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Факты о результате вызова. Пустой список — сказать нечего, и это нормальный
 * ответ: у большинства вызовов итог ровно такой, каким выглядит.
 *
 * Разбираем ТОЛЬКО встроенные инструменты, по точному имени. У инструмента
 * стороннего сервера форма своя — типы SDK говорят это прямым текстом («MCP and
 * dynamic tools carry their own shapes»), — и прочитать `mcp__browser__read`
 * формой нашего `Read` значит показать чужие числа под нашей подписью. Соблазн
 * «снять приставку и попробовать» здесь и есть источник выдуманного факта.
 */
export function toolFacts(toolName: string, result: unknown): ToolFact[] {
  const r = obj(result)
  if (!r) return []
  const name = toolName.trim().toLowerCase()
  if (name.includes('__')) return []
  switch (name) {
    case 'bash':
    /*
     * PowerShell — ТОТ ЖЕ инструмент по форме ответа.
     *
     * На Windows движок подключает его рядом с Bash, и выход у него буквально
     * тот же: `interrupted`, `timedOutAfterMs`, `backgroundTaskId`. Без этой
     * ветки на машине владельца самый ходовой шелл показывал «✓ готово» там,
     * где команда оборвана по времени или до сих пор работает в фоне, — то есть
     * ровно та ложь, ради которой всё это писалось, и ровно на той платформе,
     * где её увидят.
     */
    // eslint-disable-next-line no-fallthrough
    case 'powershell':
      return bashFacts(r)
    case 'read':
      return readFacts(r)
    case 'glob':
      return globFacts(r)
    case 'grep':
      return grepFacts(r)
    case 'edit':
    case 'write':
    case 'multiedit':
    case 'notebookedit':
      return editFacts(r)
    default:
      return []
  }
}

/**
 * Команда оболочки. Три её конца выглядят на экране одинаково, а значат разное:
 * доработала сама, была убита, ушла в фон и работает до сих пор.
 */
function bashFacts(r: Record<string, unknown>): ToolFact[] {
  const out: ToolFact[] = []
  const ms = num(r.timedOutAfterMs)
  const sec = ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000))
  const background = !!str(r.backgroundTaskId)
  /*
   * Истекло время И команда ушла в фон — это ОДНА новость, а не две.
   *
   * Раньше карточка говорила «оборвано по времени» и следом «ушла в фон и
   * работает дальше»: два взаимоисключающих утверждения подряд, из которых
   * человек не мог понять, жива команда или нет. Движок ничего не путал — он
   * назвал и срок, и то, что делать дальше; путала строка.
   */
  if (sec !== undefined && background) {
    out.push({ key: 'fact.bash.timeoutBackground', vars: { sec }, level: 'warn' })
    return out
  }
  if (sec !== undefined) {
    out.push({ key: 'fact.bash.timeout', vars: { sec }, level: 'warn' })
  } else if (r.interrupted === true) {
    // Таймаут — тоже обрыв, но с названной причиной; повторять «прервано»
    // второй строкой было бы шумом.
    out.push({ key: 'fact.bash.interrupted', level: 'warn' })
  }
  if (background) out.push({ key: 'fact.bash.background', level: 'warn' })
  return out
}

/**
 * Чтение файла. Самый опасный из «одинаково выглядящих» итогов: агент прочитал
 * двести строк из четырёх тысяч и делает вывод обо всём файле, а карточка об
 * этом молчит.
 */
function readFacts(r: Record<string, unknown>): ToolFact[] {
  const out: ToolFact[] = []
  if (r.type === 'file_unchanged') {
    out.push({ key: 'fact.read.unchanged', level: 'info' })
    return out
  }
  const f = obj(r.file)
  if (!f) return out
  const n = num(f.numLines)
  const total = num(f.totalLines)
  if (n !== undefined && total !== undefined && total > n) {
    out.push({ key: 'fact.read.part', vars: { n, total }, level: 'warn' })
  }
  if (f.truncatedByTokenCap === true) out.push({ key: 'fact.read.cap', level: 'warn' })
  return out
}

/** Поиск по именам: сколько нашлось и всё ли показано. */
function globFacts(r: Record<string, unknown>): ToolFact[] {
  const out: ToolFact[] = []
  const n = num(r.numFiles)
  if (n !== undefined) out.push({ key: 'fact.glob.found', vars: { n }, level: 'info' })
  if (r.truncated === true) {
    const total = num(r.totalMatches)
    // Полное число называем, только если движок его знает и сам ручается за
    // него (`countIsComplete`): «показано 100 из примерно 240» — это не факт.
    out.push(
      total !== undefined && r.countIsComplete === true
        ? { key: 'fact.glob.truncatedOf', vars: { total }, level: 'warn' }
        : { key: 'fact.glob.truncated', level: 'warn' }
    )
  }
  return out
}

/** Поиск по содержимому: совпадения, файлы и наложенный предел. */
function grepFacts(r: Record<string, unknown>): ToolFact[] {
  const out: ToolFact[] = []
  const matches = num(r.numMatches)
  const files = num(r.numFiles)
  if (matches !== undefined && files !== undefined) {
    out.push({ key: 'fact.grep.found', vars: { n: matches, files }, level: 'info' })
  } else if (files !== undefined) {
    out.push({ key: 'fact.grep.files', vars: { n: files }, level: 'info' })
  }
  const limit = num(r.appliedLimit)
  if (limit !== undefined) out.push({ key: 'fact.grep.limited', vars: { n: limit }, level: 'warn' })
  return out
}

/**
 * Правка файла: сколько строк она на самом деле тронула.
 *
 * Считаем по `structuredPatch` — это ИМЕННО ЭТА правка. Соседнее поле
 * `gitDiff.additions/deletions` выглядит готовым ответом и им НЕ является: там
 * дифф всего файла против гита (`status: 'modified' | 'added'`), то есть сумма
 * всех правок за сессию, а у нового файла — весь файл целиком. Подписать это
 * числом под одной карточкой значило бы приписать одной правке чужую работу.
 */
function editFacts(r: Record<string, unknown>): ToolFact[] {
  const out: ToolFact[] = []
  const hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : null
  if (hunks) {
    let plus = 0
    let minus = 0
    for (const h of hunks as Array<Record<string, unknown>>) {
      const lines = Array.isArray(h?.lines) ? h.lines : []
      for (const raw of lines) {
        if (typeof raw !== 'string') continue
        if (raw.startsWith('+')) plus++
        else if (raw.startsWith('-')) minus++
      }
    }
    // Ноль на ноль — не новость: правка, ничего не изменившая, и так видна по
    // отсутствию диффа.
    if (plus || minus) out.push({ key: 'fact.edit.diff', vars: { plus, minus }, level: 'info' })
  }
  /*
   * `userModified` — «человек поправил ПРЕДЛОЖЕНИЕ агента», а не «файл изменился
   * снаружи»: так это поле названо в типах SDK дословно. Прежняя формулировка
   * читалась как предупреждение о гонке, которой не было, — и это ровно тот
   * случай, когда интерфейс сочиняет чужую причину.
   */
  if (r.userModified === true) out.push({ key: 'fact.edit.userModified', level: 'info' })
  return out
}
