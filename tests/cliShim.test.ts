import { describe, expect, it } from 'vitest'
import {
  CLI_NAME,
  cmdShim,
  normPath,
  pathAdd,
  pathHas,
  pathRemove,
  resolveCandidates,
  shShim
} from '@shared/cliShim'

/**
 * Правка PATH — самое опасное, что Заря делает с чужой системой.
 *
 * Не дописать пункт значит «команда не появилась»: человек попробует ещё раз.
 * Испортить существующий PATH значит оставить его без половины программ, и
 * связать это с Зарёй он не сможет — ошибки будут приходить отовсюду, кроме
 * неё. Поэтому вся арифметика строки проверяется здесь, а на живой машине
 * остаётся только реестр.
 *
 * Настоящее значение PATH владельца (1184 знака, пустой пункт `;;` посередине)
 * взято за образец: на нём и проверяем, что чужое мы не трогаем.
 */
describe('normPath — что считается одной и той же папкой', () => {
  it('регистр не различается: Windows его не различает', () => {
    expect(normPath('C:\\Users\\Bin')).toBe(normPath('c:\\users\\bin'))
  })

  it('хвостовой слэш не различается', () => {
    expect(normPath('C:\\bin\\')).toBe(normPath('C:\\bin'))
  })

  it('прямой и обратный слэш в хвосте — тоже', () => {
    expect(normPath('C:\\bin/')).toBe(normPath('C:\\bin'))
  })

  it('корень диска остаётся корнем: C:\\ это не C:', () => {
    expect(normPath('C:\\')).toBe('c:\\')
  })
})

describe('pathHas', () => {
  const PATH = 'C:\\Windows;C:\\Users\\pesto\\.local\\bin;;C:\\Program Files\\Git\\cmd'

  it('находит пункт независимо от регистра и хвоста', () => {
    expect(pathHas(PATH, 'c:\\users\\pesto\\.local\\bin\\')).toBe(true)
  })

  it('чужой папки там нет', () => {
    expect(pathHas(PATH, 'C:\\Users\\pesto\\AppData\\Local\\Zarya\\bin')).toBe(false)
  })

  it('пустой пункт ни с чем не совпадает', () => {
    expect(pathHas(PATH, '')).toBe(false)
    expect(pathHas(PATH, '   ')).toBe(false)
  })

  it('похожее имя не считается совпадением', () => {
    expect(pathHas('C:\\Zarya\\bin2', 'C:\\Zarya\\bin')).toBe(false)
  })
})

describe('pathAdd — дописать, ничего не сломав', () => {
  const DIR = 'C:\\Users\\pesto\\AppData\\Local\\Zarya\\bin'

  it('дописывает в КОНЕЦ: наша папка не перебивает чужие программы', () => {
    expect(pathAdd('C:\\Windows;C:\\Git\\cmd', DIR)).toBe(`C:\\Windows;C:\\Git\\cmd;${DIR}`)
  })

  it('уже есть — null, второго пункта не появится', () => {
    expect(pathAdd(`C:\\Windows;${DIR}`, DIR)).toBeNull()
  })

  it('тот же пункт в другом регистре — тоже null', () => {
    expect(pathAdd(`C:\\Windows;${DIR.toUpperCase()}`, DIR)).toBeNull()
  })

  it('хвостовая точка с запятой не даёт пустого пункта', () => {
    expect(pathAdd('C:\\Windows;', DIR)).toBe(`C:\\Windows;${DIR}`)
  })

  it('пустой PATH — единственный пункт', () => {
    expect(pathAdd('', DIR)).toBe(DIR)
  })

  it('чужие пункты не трогаются — включая пустой посередине', () => {
    const before = 'C:\\a;;C:\\b с пробелом;C:\\c\\'
    expect(pathAdd(before, DIR)).toBe(`${before};${DIR}`)
  })

  it('переменные окружения внутри PATH остаются переменными', () => {
    const before = '%USERPROFILE%\\bin;C:\\Windows'
    expect(pathAdd(before, DIR)).toBe(`${before};${DIR}`)
  })
})

describe('pathRemove — снять за собой', () => {
  const DIR = 'C:\\Users\\pesto\\AppData\\Local\\Zarya\\bin'

  it('убирает свой пункт и возвращает остальное как было', () => {
    expect(pathRemove(`C:\\a;${DIR};C:\\b`, DIR)).toBe('C:\\a;C:\\b')
  })

  it('пункта не было — null, писать в реестр незачем', () => {
    expect(pathRemove('C:\\a;C:\\b', DIR)).toBeNull()
  })

  it('пустой пункт посреди чужого PATH остаётся на месте', () => {
    expect(pathRemove(`C:\\a;;${DIR};C:\\b`, DIR)).toBe('C:\\a;;C:\\b')
  })

  it('единственный пункт — PATH становится пустым, а не «;»', () => {
    expect(pathRemove(DIR, DIR)).toBe('')
  })

  it('снимает независимо от регистра и хвостового слэша', () => {
    expect(pathRemove(`C:\\a;${DIR.toUpperCase()}\\;C:\\b`, DIR)).toBe('C:\\a;C:\\b')
  })

  it('добавить и снять — возвращает ровно исходную строку', () => {
    const before = 'C:\\Windows;;%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd'
    const added = pathAdd(before, DIR)
    expect(added).not.toBeNull()
    expect(pathRemove(added as string, DIR)).toBe(before)
  })
})

describe('resolveCandidates — кто на самом деле откликнется на `zarya`', () => {
  const PATHEXT = '.COM;.EXE;.BAT;.CMD'

  it('папки перебираются слева направо, внутри папки — расширения по порядку', () => {
    expect(resolveCandidates(CLI_NAME, 'C:\\a;C:\\b', PATHEXT)).toEqual([
      'C:\\a\\zarya.COM',
      'C:\\a\\zarya.EXE',
      'C:\\a\\zarya.BAT',
      'C:\\a\\zarya.CMD',
      'C:\\b\\zarya.COM',
      'C:\\b\\zarya.EXE',
      'C:\\b\\zarya.BAT',
      'C:\\b\\zarya.CMD'
    ])
  })

  it('чужой exe в папке ЛЕВЕЕ нашей идёт раньше — значит он и выигрывает', () => {
    const list = resolveCandidates(CLI_NAME, 'C:\\other;C:\\zarya\\bin', PATHEXT)
    expect(list.indexOf('C:\\other\\zarya.EXE')).toBeLessThan(
      list.indexOf('C:\\zarya\\bin\\zarya.CMD')
    )
  })

  it('пустые пункты пропускаются, а не дают путей вида «\\zarya.exe»', () => {
    expect(resolveCandidates(CLI_NAME, 'C:\\a;;  ;C:\\b', '.EXE')).toEqual([
      'C:\\a\\zarya.EXE',
      'C:\\b\\zarya.EXE'
    ])
  })

  it('хвостовой слэш папки не удваивается', () => {
    expect(resolveCandidates(CLI_NAME, 'C:\\a\\', '.CMD')).toEqual(['C:\\a\\zarya.CMD'])
  })
})

describe('cmdShim — то, что ляжет в zarya.cmd', () => {
  const EXE = 'C:\\Program Files\\Zarya\\Zarya.exe'
  const BIN = 'C:\\Users\\pesto\\AppData\\Local\\Zarya\\bin'

  it('передаёт аргументы дальше — иначе `zarya .` теряет папку', () => {
    expect(cmdShim(EXE, [], BIN)).toContain('%*')
  })

  it('путь к exe в кавычках: в «Program Files» есть пробел', () => {
    expect(cmdShim(EXE, [], BIN)).toContain(`set "ZARYA_EXE=${EXE}"`)
  })

  it('проверяет, на месте ли Заря, и называет папку для снятия из PATH', () => {
    const s = cmdShim(EXE, [], BIN)
    expect(s).toContain('if not exist "%ZARYA_EXE%" goto :gone')
    expect(s).toContain(BIN)
  })

  it('в разработке первым аргументом идёт скрипт, и он в кавычках', () => {
    const s = cmdShim('C:\\node_modules\\electron.exe', ['C:\\zarya\\out\\main\\index.js'], BIN)
    expect(s).toContain('"%ZARYA_EXE%" "C:\\zarya\\out\\main\\index.js" %*')
  })

  it('процент в пути экранируется — иначе batch съест кусок строки', () => {
    expect(cmdShim('C:\\100%\\Zarya.exe', [], BIN)).toContain(
      'set "ZARYA_EXE=C:\\100%%\\Zarya.exe"'
    )
  })

  it('переводы строк CRLF: batch-файл с одними LF ведёт себя непредсказуемо', () => {
    expect(cmdShim(EXE, [], BIN).split('\r\n').length).toBeGreaterThan(5)
    expect(cmdShim(EXE, [], BIN)).not.toMatch(/[^\r]\n/)
  })
})

describe('shShim — то же самое для git-bash', () => {
  const EXE = 'C:\\Program Files\\Zarya\\Zarya.exe'
  const BIN = 'C:\\Users\\pesto\\AppData\\Local\\Zarya\\bin'

  it('передаёт аргументы дальше', () => {
    expect(shShim(EXE, [], BIN)).toContain('"$@"')
  })

  it('запускает в ФОНЕ: bash ждал бы окно Зари до самого закрытия', () => {
    expect(shShim(EXE, [], BIN)).toMatch(/&\n/)
    expect(shShim(EXE, [], BIN)).not.toContain('exec ')
  })

  it('переводит путь через cygpath, если он есть', () => {
    expect(shShim(EXE, [], BIN)).toContain('cygpath -u')
  })

  it('без cygpath не объявляет Зарю удалённой: проверка внутри его ветки', () => {
    const строки = shShim(EXE, [], BIN).split('\n')
    const cyg = строки.findIndex((l) => l.includes('command -v cygpath'))
    const проверка = строки.findIndex((l) => l.includes('[ ! -f "$ZARYA_EXE" ]'))
    const конецВетки = строки.findIndex((l, i) => i > cyg && l === 'fi')
    expect(cyg).toBeGreaterThanOrEqual(0)
    // Путь вида `C:\…` для sh — просто имя несуществующего файла, и снаружи
    // ветки проверка объявила бы установленную Зарю удалённой.
    expect(проверка).toBeGreaterThan(cyg)
    expect(проверка).toBeLessThan(конецВетки)
  })

  it('одинарная кавычка в пути не разрывает строку', () => {
    expect(shShim("C:\\Пап'ка\\Zarya.exe", [], BIN)).toContain(`'C:\\Пап'\\''ка\\Zarya.exe'`)
  })

  it('переводы строк LF: sh не переваривает CR в конце строки', () => {
    expect(shShim(EXE, [], BIN)).not.toContain('\r')
  })
})
