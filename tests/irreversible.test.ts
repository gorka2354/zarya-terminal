import { describe, expect, it } from 'vitest'
import { irreversible } from '@shared/irreversible'
import { matchesRule, ruleFor, withRule } from '@shared/allowRules'

/**
 * Пол под автопилотом и правила «до конца сессии».
 *
 * Проверяется главное свойство: автопилот означает «не спрашивай про рутину», а
 * не «делай что угодно», и обойти это через «разрешить до конца сессии» нельзя.
 */
const bash = (command: string): [string, unknown] => ['Bash', { command }]

describe('что показывается всегда', () => {
  it('удаление рекурсией — в любом написании', () => {
    for (const cmd of [
      'rm -rf build',
      'rm -fr /tmp/x',
      'rm -r --force node_modules',
      'sudo rm -rf --no-preserve-root /',
      'Remove-Item -Recurse -Force .\\dist',
      'rmdir /s /q build'
    ]) {
      expect(irreversible(...bash(cmd))?.kind, cmd).toBe('delete')
    }
  })

  it('перезапись чужой истории', () => {
    expect(irreversible(...bash('git push --force origin main'))?.kind).toBe('force-push')
    expect(irreversible(...bash('git push -f'))?.kind).toBe('force-push')
    // --force-with-lease проверяет, что чужого не затрёт, — это не то же самое.
    expect(irreversible(...bash('git push --force-with-lease'))).toBeNull()
  })

  it('снос данных и устройств', () => {
    expect(irreversible(...bash('psql -c "DROP TABLE users"'))?.kind).toBe('drop')
    expect(irreversible(...bash('TRUNCATE TABLE orders'))?.kind).toBe('drop')
    expect(irreversible(...bash('dd if=/dev/zero of=/dev/sda'))?.kind).toBe('device')
    expect(irreversible(...bash('mkfs.ext4 /dev/sdb1'))?.kind).toBe('wipe')
    expect(irreversible(...bash('git clean -fdx'))?.kind).toBe('clean')
  })

  it('рутина проходит молча — иначе автопилот бессмыслен', () => {
    for (const cmd of [
      'git status',
      'ls -la',
      'npm test',
      'rm build/app.js',
      'git reset --hard HEAD~1',
      'chmod -R 755 dist',
      'grep -rf patterns.txt src'
    ]) {
      expect(irreversible(...bash(cmd)), cmd).toBeNull()
    }
  })

  it('правки файлов сюда не относятся: их видно в диффе и можно вернуть', () => {
    expect(irreversible('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toBeNull()
    expect(irreversible('Write', { file_path: 'a.ts', content: 'rm -rf /' })).toBeNull()
  })

  it('говорит, из-за чего сработало', () => {
    const v = irreversible(...bash('cd /tmp && rm -rf cache'))
    expect(v?.hit).toContain('rm -rf')
  })
})

describe('правила «до конца сессии»', () => {
  it('для команды правило — сама команда, дословно', () => {
    expect(ruleFor(...bash('git status'))).toBe('Bash: git status')
  })

  it('выход из режима плана правилом не разрешается', () => {
    // Правило означало бы: впредь агент выходит из плана САМ, не спрашивая. Но
    // весь смысл режима — в том, что человек видит план и соглашается с ним;
    // раздав такое разрешение однажды, он оставил бы себе чип, который больше
    // ничего не защищает.
    expect(ruleFor('ExitPlanMode', {})).toBeNull()
    expect(matchesRule(['ExitPlanMode'], 'ExitPlanMode', {})).toBe(false)
  })

  it('«git status» не разрешает «git push --force»', () => {
    // Соблазн обобщить до «все git» — это и есть источник неправды.
    const rules = [ruleFor(...bash('git status'))!]
    expect(matchesRule(rules, ...bash('git status'))).toBe(true)
    expect(matchesRule(rules, ...bash('git push --force'))).toBe(false)
    expect(matchesRule(rules, ...bash('git status --short'))).toBe(false)
  })

  it('ПОИСК ПО КОНСОЛИ — отдельное решение, а не тот же список команд', () => {
    /*
     * Ревью нашло здесь дыру. `list_blocks` без аргументов отдаёт только имена
     * команд и коды возврата — «Returns no output text» сказано в его же
     * описании. С полем `contains` тот же вызов возвращает СТРОКИ ВЫВОДА, а в
     * них ключи, пути и всё, что человек когда-то запускал. Правило же строится
     * по имени инструмента, и разрешение, выданное когда-то на безобидный
     * список, молча начало бы пускать вывод.
     */
    const plain: [string, unknown] = ['mcp__zarya__list_blocks', { limit: 10 }]
    const search: [string, unknown] = ['mcp__zarya__list_blocks', { contains: 'ECONNREFUSED' }]
    expect(ruleFor(...plain)).toBe('mcp__zarya__list_blocks')
    expect(ruleFor(...search)).toBe('mcp__zarya__list_blocks: contains')
    // Главное: разрешение на список НЕ покрывает поиск.
    expect(matchesRule([ruleFor(...plain)!], ...search)).toBe(false)
    expect(matchesRule([ruleFor(...search)!], ...search)).toBe(true)
  })

  it('но поиск не дробится по искомому слову', () => {
    // Решение человека здесь про ВИД данных, а не про строку поиска: иначе
    // каждый новый запрос спрашивал бы заново, и он перестал бы читать карточки.
    const rules = [ruleFor('mcp__zarya__list_blocks', { contains: 'error' })!]
    expect(matchesRule(rules, 'mcp__zarya__list_blocks', { contains: 'timeout' })).toBe(true)
  })

  it('пустой contains — это не поиск', () => {
    expect(ruleFor('mcp__zarya__list_blocks', { contains: '   ' })).toBe('mcp__zarya__list_blocks')
  })

  it('для прочих инструментов правило — имя', () => {
    expect(ruleFor('Read', { file_path: 'a.ts' })).toBe('Read')
    expect(matchesRule(['Read'], 'Read', { file_path: 'другой.ts' })).toBe(true)
  })

  it('необратимое НЕЛЬЗЯ разрешить до конца сессии', () => {
    // Иначе пол снимался бы через боковую дверь: одно нажатие — и `rm -rf`
    // больше не спрашивают.
    expect(ruleFor(...bash('rm -rf build'))).toBeNull()
    expect(matchesRule(['Bash: rm -rf build'], ...bash('rm -rf build'))).toBe(false)
  })

  it('многострочную команду не разрешаем: вторую строку человек не прочитает', () => {
    expect(ruleFor(...bash('git status\nrm -rf build'))).toBeNull()
  })

  it('дубли не копятся', () => {
    const a = withRule([], 'Bash: ls')
    expect(withRule(a, 'Bash: ls')).toEqual(['Bash: ls'])
  })
})
