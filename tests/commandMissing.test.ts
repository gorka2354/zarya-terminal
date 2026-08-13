import { describe, expect, it } from 'vitest'
import { commandMissing, missingName } from '../src/shared/commandMissing'

/**
 * Признак «команды нет» решает, предложит ли Заря перезапустить оболочку.
 *
 * Ошибиться можно в обе стороны, и обе дорогие: промолчать — оставить человека
 * гадать, почему только что установленный инструмент «не установился»; сказать
 * лишнего — предложить перезапуск там, где он ничего не изменит, и приучить
 * жать мимо.
 */

const PS_RU = `cargo : Имя "cargo" не распознано как имя командлета, функции, файла сценария или
выполняемой программы. Проверьте правильность написания имени.
    + CategoryInfo          : ObjectNotFound: (cargo:String) [], CommandNotFoundException`
const PS_EN = `cargo : The term 'cargo' is not recognized as the name of a cmdlet, function, script file,
or operable program.`
const CMD_RU = `"cargo" не является внутренней или внешней командой, исполняемой программой или пакетным файлом.`
const BASH = `bash: cargo: command not found`
const ZSH_RU = `zsh: команда не найдена: cargo`
const SH = `/bin/sh: 1: cargo: not found`

describe('commandMissing', () => {
  it('узнаёт PowerShell на русском — ровно тот случай владельца', () => {
    expect(commandMissing({ output: PS_RU, exitCode: 1 })).toBe(true)
  })

  it('узнаёт PowerShell на английском', () => {
    expect(commandMissing({ output: PS_EN, exitCode: 1 })).toBe(true)
  })

  it('узнаёт cmd, bash, zsh и sh', () => {
    for (const out of [CMD_RU, BASH, ZSH_RU, SH]) {
      expect(commandMissing({ output: out, exitCode: 127 })).toBe(true)
    }
  })

  it('успешная команда подсказку не вызывает', () => {
    // Кто-то печатает справку со словами «command not found» — это не отказ.
    expect(commandMissing({ output: BASH, exitCode: 0 })).toBe(false)
  })

  it('команда ещё идёт — судить рано', () => {
    expect(commandMissing({ output: BASH })).toBe(false)
  })

  it('обычная ошибка программы подсказку не вызывает', () => {
    const out = 'error: could not compile `termprobe` due to 2 previous errors'
    expect(commandMissing({ output: out, exitCode: 101 })).toBe(false)
  })

  it('длинный вывод не разбирается целиком', () => {
    // Признак ищем в начале: гигабайт логов не должен стоить кадра отрисовки.
    const хвост = 'x'.repeat(10_000) + BASH
    expect(commandMissing({ output: хвост, exitCode: 127 })).toBe(false)
  })
})

describe('missingName', () => {
  it('берёт первое слово команды', () => {
    expect(missingName('cargo run --release')).toBe('cargo')
  })

  it('обрезает путь и расширение', () => {
    expect(missingName('C:\\tools\\gh.exe pr list')).toBe('gh')
    expect(missingName('/usr/local/bin/node -v')).toBe('node')
  })

  it('пустая команда — пустое имя, а не выдумка', () => {
    expect(missingName('   ')).toBe('')
  })
})
