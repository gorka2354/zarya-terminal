import { describe, expect, it } from 'vitest'
import { toolLabel } from '../src/renderer/src/features/ai/gates'

/**
 * Подпись карточки инструмента — по ПРЕДМЕТУ вызова, а не по имени инструмента.
 *
 * Все входы здесь взяты из настоящих записей Claude Code на машине владельца
 * (`~/.claude/projects/**\/*.jsonl`), а не придуманы: раньше `toolLabel` знал
 * пять полей, и каждый второй ход выпадал в голое «WebSearch», «Glob»,
 * «ToolSearch», «SendUserFile». Карточка занимала строку и не говорила ничего.
 *
 * Проверка идёт от обратного: подпись НЕ должна совпадать с именем инструмента.
 * Это ровно тот дефект, который был, и его нельзя поймать проверкой «строка не
 * пустая» — имя инструмента непустое.
 */
describe('карточка называет предмет, а не инструмент', () => {
  it('поиск в вебе — сам запрос', () => {
    const label = toolLabel('WebSearch', { query: 'Kimi CLI Moonshot AI coding agent github 2026' })
    expect(label).toBe('Kimi CLI Moonshot AI coding agent github 2026')
    expect(label).not.toBe('WebSearch')
  })

  it('чтение страницы — адрес, а не слово WebFetch', () => {
    const label = toolLabel('WebFetch', {
      url: 'https://github.com/MoonshotAI/kimi-code',
      prompt: 'Describe this project in detail…'
    })
    expect(label).toBe('https://github.com/MoonshotAI/kimi-code')
  })

  it('поиск по файлам — ШАБЛОН, а не папка', () => {
    // Главный случай: у Grep есть и pattern, и path. Раньше побеждал path, и
    // карточка показывала папку — искали-то не папку.
    const label = toolLabel('Grep', {
      pattern: 'launchPadOpen|registerActions',
      glob: '*.tsx',
      path: 'C:/Users/pesto/Desktop/zarya-terminal/src'
    })
    expect(label).toContain('launchPadOpen|registerActions')
    expect(label.indexOf('launchPadOpen')).toBeLessThan(label.indexOf('C:/Users'))
  })

  it('Glob без пути — просто шаблон', () => {
    expect(toolLabel('Glob', { pattern: 'src/**/*' })).toBe('src/**/*')
  })

  it('поиск инструментов — запрос', () => {
    expect(toolLabel('ToolSearch', { query: 'select:WebSearch,WebFetch', max_results: 5 })).toBe(
      'select:WebSearch,WebFetch'
    )
  })

  it('задача плана — её формулировка', () => {
    expect(
      toolLabel('TaskCreate', {
        subject: 'Написать trunk: shared types, main process, preload',
        description: 'Контракты и главный процесс',
        activeForm: 'Пишу ядро'
      })
    ).toBe('Написать trunk: shared types, main process, preload')
  })

  it('поручение субагенту — что поручили и кому', () => {
    const label = toolLabel('Agent', {
      description: 'Count files in src',
      subagent_type: 'general-purpose',
      model: 'sonnet',
      prompt: 'В текущем каталоге…'
    })
    expect(label).toBe('Count files in src · general-purpose')
  })

  it('файлы человеку — имя файла без пути', () => {
    const label = toolLabel('SendUserFile', {
      files: [
        'C:\\Users\\pesto\\Desktop\\zarya-terminal\\shots\\rocket.png',
        'C:\\Users\\pesto\\Desktop\\zarya-terminal\\shots\\cosmos.png'
      ]
    })
    // Путь целиком не нужен: важно ЧТО отдали, а не откуда.
    expect(label).toBe('rocket.png +1')
  })

  it('один файл — без счётчика', () => {
    expect(toolLabel('SendUserFile', { files: ['/home/egor/shots/hero.png'] })).toBe('hero.png')
  })

  it('наблюдение — цель, а не слово Monitor', () => {
    expect(toolLabel('Monitor', { target: 'b1dc6g9aw' })).toBe('b1dc6g9aw')
  })
})

describe('старые ветки не сломаны', () => {
  it('команда оболочки важнее всего остального', () => {
    expect(toolLabel('Bash', { command: 'npm run build', description: 'Сборка' })).toBe(
      'npm run build'
    )
  })

  it('правка файла — имя инструмента и путь', () => {
    expect(toolLabel('Edit', { file_path: 'C:/p/src/app.ts' })).toBe('Edit · C:/p/src/app.ts')
  })

  it('скилл называет себя и своё задание', () => {
    expect(toolLabel('Skill', { skill: 'code-review', args: 'дифф ветки' })).toContain('code-review')
  })

  it('ACP приносит описание в input.title', () => {
    expect(toolLabel('Bash', { title: 'Запускаю тесты' })).toBe('Запускаю тесты')
  })

  it('пустой вход не даёт пустую подпись', () => {
    // Безымянная карточка так же слепа, как отсутствующая: человек одобряет
    // вслепую. Имя инструмента — последний рубеж, но он должен быть.
    expect(toolLabel('Bash', null)).toBe('Bash')
    expect(toolLabel('', null)).not.toBe('')
  })

  it('пробелы в значении не превращаются в подпись из пробела', () => {
    expect(toolLabel('WebSearch', { query: '   ' })).toBe('WebSearch')
  })
})
