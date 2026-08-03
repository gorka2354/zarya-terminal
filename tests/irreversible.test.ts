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

  it('«git status» не разрешает «git push --force»', () => {
    // Соблазн обобщить до «все git» — это и есть источник неправды.
    const rules = [ruleFor(...bash('git status'))!]
    expect(matchesRule(rules, ...bash('git status'))).toBe(true)
    expect(matchesRule(rules, ...bash('git push --force'))).toBe(false)
    expect(matchesRule(rules, ...bash('git status --short'))).toBe(false)
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
