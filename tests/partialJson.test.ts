import { describe, expect, it } from 'vitest'
import { partialArg } from '@shared/partialJson'

/**
 * Строка живёт секунды и тут же сменяется настоящей карточкой — цена ошибки
 * здесь мигнувшее превью, а не запись в беседе. Но именно поэтому её легко
 * сделать врущей и не заметить: проверяется то, что человек читает краем глаза.
 *
 * Главное здесь — не «разобрать JSON» (он заведомо недописан), а не показать
 * кусок ЧУЖОГО значения под видом поля.
 */
describe('partialArg — вытащить читаемое из недописанного', () => {
  it('пусто на пустом', () => {
    expect(partialArg('')).toBe('')
    expect(partialArg('{')).toBe('')
    expect(partialArg('{"comm')).toBe('')
  })

  it('незакрытая строка читается до конца пришедшего', () => {
    expect(partialArg('{"command": "npm run bu')).toBe('npm run bu')
  })

  it('закрытая — до кавычки, без хвоста объекта', () => {
    expect(partialArg('{"command": "npm test", "timeout": 5}')).toBe('npm test')
  })

  it('порядок полей наш, а не в файле: команда важнее пути', () => {
    expect(partialArg('{"file_path": "a.ts", "command": "ls"}')).toBe('ls')
  })

  it('берёт следующее поле, когда первого нет', () => {
    expect(partialArg('{"file_path": "src/app.ts"')).toBe('src/app.ts')
    expect(partialArg('{"pattern": "TODO", "path": "src"')).toBe('TODO')
  })

  it('экранированные кавычки не обрывают значение', () => {
    expect(partialArg('{"command": "echo \\"hi\\" && ls')).toBe('echo "hi" && ls')
  })

  it('обратный слэш остаётся собой — это путь Windows, а не escape', () => {
    expect(partialArg('{"file_path": "C:\\\\src\\\\app.ts"')).toBe('C:\\src\\app.ts')
  })

  it('переносы схлопываются: это строка на один взгляд', () => {
    expect(partialArg('{"command": "a\\nb\\tc"')).toBe('a b c')
  })

  it('оборванная escape-последовательность не роняет разбор', () => {
    expect(partialArg('{"command": "a\\')).toBe('a')
    expect(partialArg('{"command": "a\\u00')).toBe('a')
  })

  it('\\u-код превращается в знак', () => {
    expect(partialArg('{"command": "\\u0061bc')).toBe('abc')
  })

  it('длинное обрезается многоточием, а не растягивает строку', () => {
    const long = 'x'.repeat(400)
    const out = partialArg(`{"command": "${long}`)
    expect(out.length).toBeLessThanOrEqual(161)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('partialArg — не выдаёт чужое за своё', () => {
  it('имя поля ВНУТРИ значения не считается полем', () => {
    // Классическая ловушка: команда ищет по слову «file_path». Взяв первое
    // вхождение, превью показало бы кусок команды как путь к файлу.
    expect(partialArg('{"command": "grep \\"file_path\\" src/')).toBe('grep "file_path" src/')
  })

  it('поле после запятой — настоящее поле', () => {
    expect(partialArg('{"limit": 5, "pattern": "TODO"')).toBe('TODO')
  })

  it('нестроковое значение не показываем — превью для человека, а не дамп', () => {
    expect(partialArg('{"command": 42}')).toBe('')
    expect(partialArg('{"command": {"nested": "x"}}')).toBe('')
  })

  it('незнакомые поля игнорируются молча', () => {
    expect(partialArg('{"whatever": "нечто"}')).toBe('')
  })

  it('пробелы вокруг двоеточия не мешают', () => {
    expect(partialArg('{ "command"   :    "ls -la"')).toBe('ls -la')
  })

  it('ведущие пробелы значения снимаются, внутренние — нет', () => {
    expect(partialArg('{"command": "  npm  test"')).toBe('npm test')
  })
})
