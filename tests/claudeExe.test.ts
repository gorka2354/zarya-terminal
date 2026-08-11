import { homedir } from 'os'
import { describe, expect, it } from 'vitest'
import {
  bundledPkgName,
  claudeExeName,
  compareVersions,
  parseCliVersion,
  checkpointDecision,
  firstExisting,
  flagUnsupported,
  pickClaudeExe,
  probeFlag,
  resetFlagCache,
  resolveClaudeExe,
  supportsFlag,
  systemClaudeCandidates
} from '../src/main/claudeExe'

describe('parseCliVersion', () => {
  it('parses the real --version banner', () => {
    expect(parseCliVersion('2.1.220 (Claude Code)')).toEqual([2, 1, 220])
  })

  it('tolerates surrounding noise and newlines', () => {
    expect(parseCliVersion('\n  2.1.217 (Claude Code)\n')).toEqual([2, 1, 217])
  })

  it('returns undefined for unparseable output', () => {
    expect(parseCliVersion('command not found')).toBeUndefined()
    expect(parseCliVersion('')).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('orders by each segment, patch included', () => {
    expect(compareVersions([2, 1, 220], [2, 1, 217])).toBe(1)
    expect(compareVersions([2, 1, 217], [2, 1, 220])).toBe(-1)
    expect(compareVersions([2, 1, 220], [2, 1, 220])).toBe(0)
  })

  it('does not compare patch numbers lexically (220 > 99)', () => {
    expect(compareVersions([2, 1, 220], [2, 1, 99])).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions([2, 1], [2, 1, 0])).toBe(0)
    expect(compareVersions([3], [2, 9, 9])).toBe(1)
  })
})

describe('bundledPkgName / claudeExeName', () => {
  it('maps each platform to its SDK binary package', () => {
    expect(bundledPkgName('win32', 'x64')).toBe('claude-agent-sdk-win32-x64')
    expect(bundledPkgName('darwin', 'arm64')).toBe('claude-agent-sdk-darwin-arm64')
    expect(bundledPkgName('linux', 'x64')).toBe('claude-agent-sdk-linux-x64')
  })

  it('only Windows gets the .exe suffix', () => {
    expect(claudeExeName('win32')).toBe('claude.exe')
    expect(claudeExeName('darwin')).toBe('claude')
    expect(claudeExeName('linux')).toBe('claude')
  })
})

describe('systemClaudeCandidates', () => {
  it('puts the npm-global install first on Windows', () => {
    const c = systemClaudeCandidates(
      'win32',
      { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      'C:\\Users\\u'
    )
    expect(c[0]).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
    )
    expect(c).toContain('C:\\Users\\u\\.local\\bin\\claude.exe')
  })

  it('survives a Windows env with no APPDATA set', () => {
    const c = systemClaudeCandidates('win32', {}, 'C:\\Users\\u')
    expect(c.length).toBeGreaterThan(0)
    expect(c.every((p) => typeof p === 'string' && p.length > 0)).toBe(true)
  })

  it('uses POSIX locations off Windows', () => {
    const c = systemClaudeCandidates('linux', {}, '/home/u')
    expect(c).toContain('/home/u/.local/bin/claude')
    expect(c).toContain('/usr/local/bin/claude')
    expect(c.every((p) => !p.endsWith('.exe'))).toBe(true)
  })
})

describe('pickClaudeExe — which binary Zarya runs', () => {
  const bundled = { path: '/app/bundled/claude', version: [2, 1, 217] }

  it('an explicit env override beats everything', () => {
    expect(
      pickClaudeExe({
        envOverride: '/custom/claude',
        bundled,
        system: { path: '/usr/bin/claude', version: [9, 9, 9] }
      })
    ).toEqual({ path: '/custom/claude', reason: 'env' })
  })

  it('ignores a blank/whitespace env override', () => {
    expect(pickClaudeExe({ envOverride: '   ', bundled }).reason).toBe('bundled')
  })

  it('prefers a strictly newer system CLI on the same major (the Opus 5 case)', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [2, 1, 220] } })
    ).toEqual({ path: '/usr/bin/claude', reason: 'system-newer' })
  })

  it('never downgrades to an older system CLI', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [2, 1, 200] } }).reason
    ).toBe('bundled')
  })

  it('does not switch on an equal version (no reason to leave the shipped binary)', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [2, 1, 217] } }).reason
    ).toBe('bundled')
  })

  it('refuses to cross a MAJOR version even when newer (protocol track guard)', () => {
    expect(
      pickClaudeExe({ bundled, system: { path: '/usr/bin/claude', version: [3, 0, 0] } }).reason
    ).toBe('bundled')
  })

  it('ignores a system binary whose version could not be probed', () => {
    expect(pickClaudeExe({ bundled, system: { path: '/usr/bin/claude' } }).reason).toBe('bundled')
  })

  it('ignores a system binary when the bundled one is unprobeable', () => {
    expect(
      pickClaudeExe({
        bundled: { path: '/app/bundled/claude' },
        system: { path: '/usr/bin/claude', version: [2, 1, 220] }
      }).reason
    ).toBe('bundled')
  })

  it('falls back to the SDK default when nothing is resolvable', () => {
    expect(pickClaudeExe({})).toEqual({ reason: 'sdk-default' })
  })
})

describe('resolveClaudeExe', () => {
  it('short-circuits on ZARYA_CLAUDE_BIN without touching the disk', async () => {
    const pick = await resolveClaudeExe({
      bundledPath: '/nope/does-not-exist',
      platform: 'linux',
      env: { ZARYA_CLAUDE_BIN: '/opt/claude' },
      home: '/home/u'
    })
    expect(pick).toEqual({ path: '/opt/claude', reason: 'env' })
  })

  it('degrades to the SDK default when no binary exists anywhere', async () => {
    const pick = await resolveClaudeExe({
      bundledPath: undefined,
      platform: 'linux',
      env: {},
      home: '/nonexistent-home-for-test'
    })
    expect(pick.reason).toBe('sdk-default')
    expect(pick.path).toBeUndefined()
  })
})

/**
 * Проба флага перед его использованием.
 *
 * Часть возможностей движка включается флагом, которого нет в контракте SDK
 * (`--replay-user-messages`). SDK передаёт такой флаг сырым, а CLI на
 * неизвестный корневой флаг падает ДО начала хода. Заря перевыбирает бинарник
 * каждые полчаса без перезапуска — значит после самообновления `claude`
 * человек получил бы не «нет кнопки отката», а «агент не отвечает» на каждый
 * ход. Поэтому решение «ставить ли флаг» проверяется здесь.
 */
describe('flagUnsupported', () => {
  const FLAG = '--replay-user-messages'

  it('узнаёт отказ CLI по сообщению и имени флага', () => {
    expect(flagUnsupported("error: unknown option '--replay-user-messages'", FLAG)).toBe(true)
  })

  it('чужой неизвестный аргумент не выключает нашу возможность', () => {
    // Сообщение про ДРУГОЙ флаг (опечатка в подкоманде, чужая обёртка) не
    // говорит ничего о нашем — гасить функцию по нему значит гасить наугад.
    expect(flagUnsupported("error: unknown option '--typo'", FLAG)).toBe(false)
  })

  it('обычная справка и пустой вывод — это не отказ', () => {
    // `claude mcp` без подкоманды печатает Usage и выходит с кодом 1: код
    // выхода здесь ничего не значит, значение имеет только текст.
    expect(flagUnsupported('Usage: claude mcp [options] [command]', FLAG)).toBe(false)
    expect(flagUnsupported('', FLAG)).toBe(false)
  })
})

describe('supportsFlag', () => {
  const FLAG = '--replay-user-messages'

  it('спрашивает бинарник один раз и помнит ответ', async () => {
    resetFlagCache()
    let calls = 0
    const probe = async (): Promise<boolean> => {
      calls++
      return true
    }
    expect(await supportsFlag('C:/claude.exe', FLAG, 1000, 0, probe)).toBe(true)
    expect(await supportsFlag('C:/claude.exe', FLAG, 1000, 500, probe)).toBe(true)
    expect(calls).toBe(1)
  })

  it('через срок жизни спрашивает заново: CLI мог обновиться', async () => {
    resetFlagCache()
    let calls = 0
    const probe = async (): Promise<boolean> => {
      calls++
      return calls === 1
    }
    expect(await supportsFlag('C:/claude.exe', FLAG, 1000, 0, probe)).toBe(true)
    expect(await supportsFlag('C:/claude.exe', FLAG, 1000, 1500, probe)).toBe(false)
    expect(calls).toBe(2)
  })

  it('разные бинарники отвечают за себя, а не друг за друга', async () => {
    resetFlagCache()
    const probe = async (exe: string): Promise<boolean> => exe.includes('new')
    expect(await supportsFlag('C:/new/claude.exe', FLAG, 1000, 0, probe)).toBe(true)
    expect(await supportsFlag('C:/old/claude.exe', FLAG, 1000, 0, probe)).toBe(false)
  })
})

/**
 * ЖИВАЯ проба — на настоящем бинарнике.
 *
 * Всё, что выше, проверяет наш разбор ответа. А вопрос, ради которого проба
 * существует, лежит в поведении чужой программы: как именно CLI реагирует на
 * неизвестный корневой флаг и не стоит ли эта проверка секунд. Ответ на него
 * нельзя получить моком, поэтому здесь запускается настоящий `claude`. Там, где
 * его нет (CI), тест честно пропускается, а не проходит «зелёным».
 */
describe('probeFlag на настоящем CLI', () => {
  const exe = firstExisting(
    systemClaudeCandidates(process.platform, process.env, homedir())
  )

  it.skipIf(!exe)('известный флаг признаётся поддержанным', async () => {
    const started = Date.now()
    expect(await probeFlag(exe as string, '--replay-user-messages')).toBe(true)
    // Проба идёт перед запуском агента: секунды здесь человек ждёт молча.
    expect(Date.now() - started).toBeLessThan(8000)
  }, 20000)

  it.skipIf(!exe)('выдуманный флаг признаётся неподдержанным', async () => {
    // Главная проверка: CLI и правда отвечает «unknown option», а не глотает
    // чужой флаг молча — иначе вся защита была бы бумажной.
    expect(await probeFlag(exe as string, '--zzz-not-a-real-flag')).toBe(false)
  }, 20000)
})

/**
 * Решение «ставить ли флаг» — самое несимметричное место инкремента: лишний
 * флаг убивает ЗАПУСК агента (CLI падает на неизвестном корневом аргументе до
 * начала хода), а отсутствующий всего лишь прячет кнопку отката. Поэтому здесь
 * проверяется, что любое «не знаем» трактуется в пользу работающего агента.
 */
describe('checkpointDecision', () => {
  it('настройка выключена — ни флага, ни чекпоинтов', () => {
    expect(checkpointDecision({ wanted: false, exeKnown: true, flagSupported: true })).toEqual({
      enable: false,
      off: 'setting'
    })
  })

  it('бинарник выбирает SDK — спросить не у кого, значит не ставим', () => {
    // Здесь мы не знаем, ЧТО именно запустится: ставить сырой флаг вслепую
    // значит рискнуть запуском агента ради кнопки.
    expect(checkpointDecision({ wanted: true, exeKnown: false, flagSupported: true })).toEqual({
      enable: false,
      off: 'unknown-exe'
    })
  })

  it('бинарник флага не знает — молчим о чекпоинтах, агент работает', () => {
    expect(checkpointDecision({ wanted: true, exeKnown: true, flagSupported: false })).toEqual({
      enable: false,
      off: 'flag-unsupported'
    })
  })

  it('всё сошлось — включаем чекпоинты и просим id хода', () => {
    expect(checkpointDecision({ wanted: true, exeKnown: true, flagSupported: true })).toEqual({
      enable: true,
      extraArgs: { 'replay-user-messages': null }
    })
  })
})
