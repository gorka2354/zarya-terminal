import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { isRealWithinRoot, isWithinRoot } from '../src/main/acpDriver'

// Mirror the driver's lexical gate: resolve the agent-supplied path against cwd,
// then require lexical containment (or the path being cwd itself).
const containedLexically = (cwd: string, input: string): boolean => {
  const abs = resolve(cwd, input)
  return isWithinRoot(abs, cwd) || abs === resolve(cwd)
}

describe('isWithinRoot — lexical fs-proxy boundary', () => {
  const cwd = resolve('/tmp/zarya-root')

  it('allows paths inside cwd', () => {
    expect(containedLexically(cwd, 'file.txt')).toBe(true)
    expect(containedLexically(cwd, 'sub/deep/file.txt')).toBe(true)
    expect(containedLexically(cwd, './x.txt')).toBe(true)
    expect(containedLexically(cwd, '.')).toBe(true) // cwd itself
  })

  it('rejects `..` traversal (fwd and back slash)', () => {
    expect(containedLexically(cwd, '../escape.txt')).toBe(false)
    expect(containedLexically(cwd, '../../etc/passwd')).toBe(false)
    expect(containedLexically(cwd, 'sub/../../escape')).toBe(false)
    expect(containedLexically(cwd, '..\\..\\win')).toBe(false)
  })

  it('rejects absolute / other-root escapes', () => {
    // An absolute path resolves away from cwd → not contained.
    expect(isWithinRoot(resolve('/etc/passwd'), cwd)).toBe(false)
    expect(isWithinRoot(resolve('/tmp/zarya-root-sibling/x'), cwd)).toBe(false)
  })
})

describe('isRealWithinRoot — symlink/junction escape (the review finding)', () => {
  it('rejects a link inside cwd that resolves outside; allows a real inside file', () => {
    const base = mkdtempSync(join(tmpdir(), 'zy-fsg-'))
    const cwd = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(cwd)
    mkdirSync(outside)
    writeFileSync(join(outside, 'victim.txt'), 'x')

    let linked = false
    try {
      // Junction on Windows (no admin needed), dir symlink elsewhere.
      symlinkSync(outside, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      linked = true
    } catch {
      /* no symlink perms on this host — skip the escape assertion below */
    }

    // Control: a genuine file inside cwd always passes.
    writeFileSync(join(cwd, 'ok.txt'), 'y')
    expect(isRealWithinRoot(join(cwd, 'ok.txt'), cwd)).toBe(true)

    if (linked) {
      // Lexically inside cwd, but realpath resolves outside → must be rejected.
      expect(isRealWithinRoot(join(cwd, 'link', 'victim.txt'), cwd)).toBe(false)
    }

    rmSync(base, { recursive: true, force: true })
  })

  /*
   * ВИСЯЧАЯ ссылка — та, чьей цели ЕЩЁ НЕТ.
   *
   * Прошлая проверка поднималась к «существующему предку» через `existsSync`, а
   * он идёт через stat, то есть следует по ссылке: для битой ссылки отвечал «не
   * существует», подъём перескакивал через неё на обычного родителя внутри
   * проекта, и оба рубежа пропускали. Дальше запись открывала файл с O_CREAT,
   * следовала по ссылке и создавала его СНАРУЖИ корня.
   *
   * Достаточно было положить в репозиторий `notes.md -> ~/.zshenv`: агент
   * пишет «внутрь проекта», а файл появляется в домашней папке — и исполняется
   * при следующем входе в оболочку. Проверено на живом Linux: старая логика
   * пропускала и запись реально уходила наружу.
   */
  it('rejects a DANGLING link whose target does not exist yet', () => {
    const base = mkdtempSync(join(tmpdir(), 'zy-fsg-dangling-'))
    const cwd = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(cwd)
    mkdirSync(outside)

    let linked = false
    try {
      // Цели НЕТ намеренно: именно этот случай обходил рубеж.
      symlinkSync(join(outside, 'not-yet.txt'), join(cwd, 'notes.md'), 'file')
      linked = true
    } catch {
      /* нет прав на симлинки (Windows без режима разработчика) — пропускаем */
    }

    if (linked) {
      expect(isRealWithinRoot(join(cwd, 'notes.md'), cwd)).toBe(false)
    }
    // Контроль: новый файл внутри проекта (цели тоже ещё нет) обязан проходить,
    // иначе «починили» превратилось бы в «запретили всё».
    expect(isRealWithinRoot(join(cwd, 'brand-new.txt'), cwd)).toBe(true)

    rmSync(base, { recursive: true, force: true })
  })
})
