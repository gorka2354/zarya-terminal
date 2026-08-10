import { describe, expect, it } from 'vitest'
import { toolFacts } from '@shared/toolFacts'

/**
 * Здесь проверяется не удобство, а честность: три конца команды оболочки
 * выглядят на экране одинаково, и только эти строки их различают. Ошибка в
 * разборе даёт не пустое место, а УТВЕРЖДЕНИЕ — «прочитано 200 из 4000» там,
 * где прочитан весь файл, или молчание там, где вывод оборван.
 *
 * Формы приходят из чужих типов и меняются с версией SDK, поэтому отдельно
 * проверяется и главное правило: незнакомое даёт пустой список, а не догадку.
 */
const keys = (f: ReturnType<typeof toolFacts>): string[] => f.map((x) => x.key)

describe('toolFacts — мусор на входе не рождает утверждений', () => {
  it('не объект — пусто', () => {
    expect(toolFacts('Bash', null)).toEqual([])
    expect(toolFacts('Bash', 'сломалось')).toEqual([])
    expect(toolFacts('Bash', [1, 2, 3])).toEqual([])
  })

  it('незнакомый инструмент — пусто, а не догадка по чужой форме', () => {
    expect(toolFacts('WebFetch', { numFiles: 3, truncated: true })).toEqual([])
  })

  it('знакомый инструмент с пустым результатом — тоже пусто', () => {
    expect(toolFacts('Bash', {})).toEqual([])
    expect(toolFacts('Read', {})).toEqual([])
  })

  it('инструмент чужого сервера не читается формой нашего', () => {
    /*
     * Типы SDK прямо говорят: у MCP-инструментов формы СВОИ. Совпадение
     * последнего слова с именем встроенного — не повод показать чужие числа под
     * нашей подписью, даже если поля случайно легли похоже.
     */
    expect(toolFacts('mcp__srv__read', { file: { numLines: 1, totalLines: 9 } })).toEqual([])
    expect(toolFacts('mcp__browser__bash', { interrupted: true })).toEqual([])
  })

  it('регистр имени значения не имеет', () => {
    expect(toolFacts('BASH', { interrupted: true })).toHaveLength(1)
  })
})

describe('Bash — три конца, которые выглядели одинаково', () => {
  it('оборвано по времени: названа причина и срок', () => {
    const f = toolFacts('Bash', { interrupted: true, timedOutAfterMs: 120_000 })
    expect(f).toEqual([{ key: 'fact.bash.timeout', vars: { sec: 120 }, level: 'warn' }])
  })

  it('прервано без таймаута — сказано просто «прервано»', () => {
    expect(keys(toolFacts('Bash', { interrupted: true }))).toEqual(['fact.bash.interrupted'])
  })

  it('таймаут не дублируется вторым «прервано»', () => {
    const f = toolFacts('Bash', { interrupted: true, timedOutAfterMs: 5_000 })
    expect(f).toHaveLength(1)
  })

  it('ушло в фон — предупреждение: карточка закрыта, а процесс идёт', () => {
    const f = toolFacts('Bash', { backgroundTaskId: 'bg-1' })
    expect(f).toEqual([{ key: 'fact.bash.background', level: 'warn' }])
  })

  it('обычная команда молчит', () => {
    expect(toolFacts('Bash', { stdout: 'ok', stderr: '', interrupted: false })).toEqual([])
  })
})

describe('Read — сколько агент на самом деле увидел', () => {
  it('прочитана часть файла — названы обе цифры', () => {
    const f = toolFacts('Read', { type: 'text', file: { numLines: 200, totalLines: 4000 } })
    expect(f).toEqual([{ key: 'fact.read.part', vars: { n: 200, total: 4000 }, level: 'warn' }])
  })

  it('прочитан весь файл — сказать нечего', () => {
    expect(toolFacts('Read', { type: 'text', file: { numLines: 40, totalLines: 40 } })).toEqual([])
  })

  it('обрезано по объёму — отдельная новость', () => {
    const f = toolFacts('Read', {
      type: 'text',
      file: { numLines: 10, totalLines: 10, truncatedByTokenCap: true }
    })
    expect(keys(f)).toEqual(['fact.read.cap'])
  })

  it('файл не менялся — просто справка', () => {
    const f = toolFacts('Read', { type: 'file_unchanged', file: { filePath: 'a.ts' } })
    expect(f).toEqual([{ key: 'fact.read.unchanged', level: 'info' }])
  })
})

describe('Glob и Grep — всё ли показано', () => {
  it('число найденного — справка, обрезка — предупреждение', () => {
    const f = toolFacts('Glob', { numFiles: 100, truncated: true })
    expect(f).toEqual([
      { key: 'fact.glob.found', vars: { n: 100 }, level: 'info' },
      { key: 'fact.glob.truncated', level: 'warn' }
    ])
  })

  it('полное число называем, только когда движок за него ручается', () => {
    const guess = toolFacts('Glob', { numFiles: 100, truncated: true, totalMatches: 240 })
    expect(keys(guess)).toContain('fact.glob.truncated')
    const sure = toolFacts('Glob', {
      numFiles: 100,
      truncated: true,
      totalMatches: 240,
      countIsComplete: true
    })
    expect(sure[1]).toEqual({ key: 'fact.glob.truncatedOf', vars: { total: 240 }, level: 'warn' })
  })

  it('поиск без обрезки — только цифры', () => {
    expect(toolFacts('Grep', { numMatches: 12, numFiles: 4 })).toEqual([
      { key: 'fact.grep.found', vars: { n: 12, files: 4 }, level: 'info' }
    ])
  })

  it('режим без счёта совпадений — говорим только про файлы', () => {
    expect(keys(toolFacts('Grep', { mode: 'files_with_matches', numFiles: 7 }))).toEqual([
      'fact.grep.files'
    ])
  })

  it('наложенный предел назван числом', () => {
    const f = toolFacts('Grep', { numFiles: 50, appliedLimit: 50 })
    expect(f[1]).toEqual({ key: 'fact.grep.limited', vars: { n: 50 }, level: 'warn' })
  })
})

describe('Правка — размер ЭТОЙ правки, а не всего файла', () => {
  const patch = (lines: string[]): unknown => ({
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines }]
  })

  it('считаем по строкам патча', () => {
    const f = toolFacts('Edit', patch([' keep', '-was', '+now', '+extra']))
    expect(f).toEqual([{ key: 'fact.edit.diff', vars: { plus: 2, minus: 1 }, level: 'info' }])
  })

  it('несколько кусков складываются', () => {
    const f = toolFacts('Edit', {
      structuredPatch: [
        { lines: ['+a', '-b'] },
        { lines: ['+c', '+d', '-e'] }
      ]
    })
    expect(f[0].vars).toEqual({ plus: 3, minus: 2 })
  })

  it('gitDiff НЕ берём: там дифф всего файла против гита, а не этой правки', () => {
    /*
     * Соблазн выглядит готовым ответом: `additions`/`deletions` лежат рядом. Но
     * это сумма всех правок файла за сессию, а у нового файла — весь файл
     * целиком. Подписать это под одной карточкой значило бы приписать одной
     * правке чужую работу.
     */
    expect(toolFacts('Edit', { gitDiff: { additions: 400, deletions: 120 } })).toEqual([])
  })

  it('правка, ничего не изменившая, молчит', () => {
    expect(toolFacts('Edit', patch([' keep', ' same']))).toEqual([])
  })

  it('человек поправил предложение агента — справка, а не тревога', () => {
    // В типах SDK это поле названо дословно: «Whether the user modified the
    // proposed changes». Не «файл изменился снаружи» — прежняя формулировка
    // сочиняла гонку, которой не было.
    const f = toolFacts('Write', { userModified: true })
    expect(f).toEqual([{ key: 'fact.edit.userModified', level: 'info' }])
  })
})

describe('Таймаут и фон — одна новость, а не две противоречивых', () => {
  it('истекло время И ушло в фон: сказано одной строкой', () => {
    const f = toolFacts('Bash', {
      interrupted: true,
      timedOutAfterMs: 120_000,
      backgroundTaskId: 'bg-7'
    })
    // Иначе карточка говорила «оборвано по времени» и следом «работает
    // дальше» — два взаимоисключающих утверждения подряд.
    expect(f).toEqual([
      { key: 'fact.bash.timeoutBackground', vars: { sec: 120 }, level: 'warn' }
    ])
  })

  it('только таймаут — прежняя строка', () => {
    expect(keys(toolFacts('Bash', { timedOutAfterMs: 30_000 }))).toEqual(['fact.bash.timeout'])
  })

  it('только фон — прежняя строка', () => {
    expect(keys(toolFacts('Bash', { backgroundTaskId: 'bg-1' }))).toEqual(['fact.bash.background'])
  })
})
