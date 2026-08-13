import { describe, expect, it } from 'vitest'
import { programTitle } from '@shared/programTitle'

/**
 * Заголовок от программы полезен ровно до тех пор, пока он говорит о РАБОТЕ.
 *
 * Windows PowerShell при старте подписывается путём к собственному exe — и в
 * списке сессий владельца оказались четыре панели с именем
 * `C:\WINDOWS\System32\Win…`, неотличимые друг от друга и не говорящие ни о
 * папке, ни о деле. Это хуже, чем было до inc-31, когда бралось имя каталога.
 *
 * Отсекаем по форме, а не по совпадению с настоящим путём нашей оболочки: про
 * чужую оболочку мы ничего не знаем, а `.exe` в конце знаем.
 */
describe('programTitle — что программа сказала о себе полезного', () => {
  it('обычная подпись проходит', () => {
    expect(programTitle('egor@egorka23: ~/code')).toBe('egor@egorka23: ~/code')
    expect(programTitle('note.txt (~/proj) - VIM')).toBe('note.txt (~/proj) - VIM')
    expect(programTitle('htop')).toBe('htop')
  })

  it('самоподпись Windows PowerShell не берётся', () => {
    expect(
      programTitle('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ).toBeNull()
  })

  it('cmd.exe и pwsh — то же самое', () => {
    expect(programTitle('C:\\WINDOWS\\system32\\cmd.exe')).toBeNull()
    expect(programTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBeNull()
  })

  it('голое имя исполняемого файла тоже не подпись', () => {
    expect(programTitle('powershell.exe')).toBeNull()
    expect(programTitle('bash.exe')).toBeNull()
  })

  it('регистр расширения не спасает', () => {
    expect(programTitle('C:\\WINDOWS\\System32\\CMD.EXE')).toBeNull()
  })

  it('фраза с именем программы внутри — это подпись, а не путь', () => {
    // Про запущенное `npm run build` человеку знать полезно.
    expect(programTitle('npm run build.cmd в проекте')).toBe('npm run build.cmd в проекте')
  })

  it('пустой и одни управляющие знаки — ничего', () => {
    expect(programTitle('')).toBeNull()
    expect(programTitle('   ')).toBeNull()
    expect(programTitle('\u0001\u0002')).toBeNull()
  })

  it('управляющие знаки выкидываются, а текст остаётся', () => {
    expect(programTitle('vim\u0007 file.txt')).toBe('vim file.txt')
  })

  it('длинный заголовок обрезается — программа называет себя, а не верстает окно', () => {
    const long = 'ы'.repeat(200)
    const out = programTitle(long)
    expect(out).not.toBeNull()
    expect((out as string).length).toBe(61)
    expect(out).toMatch(/…$/)
  })
})
