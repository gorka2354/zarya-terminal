import { describe, expect, it } from 'vitest'
import {
  commandOf,
  foldMcpTokens,
  hostOf,
  mcpLoginCommand,
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

  it('кавычки и подстановки внутри имени экранируются', () => {
    expect(mcpLoginCommand('a"b')).toBe('claude mcp login "a\\"b"')
    expect(mcpLoginCommand('$(rm -rf /)')).toBe('claude mcp login "\\$(rm -rf /)"')
    expect(mcpLoginCommand('back\\slash')).toBe('claude mcp login "back\\\\slash"')
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
