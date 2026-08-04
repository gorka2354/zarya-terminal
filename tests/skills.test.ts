import { describe, expect, it } from 'vitest'
import {
  asSkillState,
  effectiveState,
  isPluginSkill,
  pluginDisableCommand,
  pluginOf,
  sourceLabel,
  withSkillOverride
} from '@shared/skills'
import { skillsFrom } from '@shared/mcp'

/**
 * Скиллы: слои настроек, правка чужого файла и обратный путь.
 *
 * Здесь проверяется не оформление, а три обещания интерфейса: (1) состояние на
 * экране совпадает с тем, что реально действует, включая перекрытия слоями;
 * (2) правка `~/.claude/settings.json` не теряет чужие ключи и не оставляет
 * следов Зари, когда скилл вернули в обычное состояние; (3) выключенный скилл
 * остаётся видимым в списке — иначе включить его обратно было бы нечем.
 */
describe('состояние с учётом слоёв', () => {
  it('без переопределений скилл в работе и ничьим не помечен', () => {
    expect(effectiveState('code-review', {})).toEqual({ state: 'on' })
  })

  it('личная настройка действует и названа', () => {
    expect(effectiveState('deploy', { user: { deploy: 'off' } })).toEqual({
      state: 'off',
      from: 'user'
    })
  })

  it('проект перебивает личное — иначе переключатель врал бы об эффекте', () => {
    expect(
      effectiveState('deploy', { user: { deploy: 'off' }, project: { deploy: 'name-only' } })
    ).toEqual({ state: 'name-only', from: 'project' })
  })

  it('локальный слой сильнее обоих', () => {
    expect(
      effectiveState('deploy', {
        user: { deploy: 'off' },
        project: { deploy: 'name-only' },
        local: { deploy: 'on' }
      })
    ).toEqual({ state: 'on', from: 'local' })
  })

  it('мусор в чужом файле не выдаём за состояние', () => {
    expect(effectiveState('deploy', { user: { deploy: 'ВКЛЮЧЕНО' } })).toEqual({ state: 'on' })
    expect(asSkillState('sometimes')).toBeUndefined()
    expect(asSkillState('name-only')).toBe('name-only')
  })
})

describe('правка чужого конфига', () => {
  it('соседние ключи переживают запись', () => {
    const before = { model: 'opus', hooks: { PreToolUse: [1] }, effortLevel: 'high' }
    const after = withSkillOverride(before, 'deploy', 'off')
    expect(after.model).toBe('opus')
    expect(after.hooks).toEqual({ PreToolUse: [1] })
    expect(after.skillOverrides).toEqual({ deploy: 'off' })
  })

  it('исходный объект не меняется — правка не расползается по main', () => {
    const before: Record<string, unknown> = { skillOverrides: { a: 'off' } }
    withSkillOverride(before, 'b', 'off')
    expect(before.skillOverrides).toEqual({ a: 'off' })
  })

  it('возврат в обычное состояние убирает ключ, а не пишет "on"', () => {
    const after = withSkillOverride({ skillOverrides: { deploy: 'off', keep: 'off' } }, 'deploy', 'on')
    expect(after.skillOverrides).toEqual({ keep: 'off' })
  })

  it('последний возврат уносит и пустой раздел — следов Зари не остаётся', () => {
    const after = withSkillOverride({ model: 'opus', skillOverrides: { deploy: 'off' } }, 'deploy', 'on')
    expect(after).toEqual({ model: 'opus' })
    expect('skillOverrides' in after).toBe(false)
  })

  it('сломанный skillOverrides не роняет запись и заменяется здоровым', () => {
    const after = withSkillOverride({ skillOverrides: ['ерунда'] }, 'deploy', 'off')
    expect(after.skillOverrides).toEqual({ deploy: 'off' })
  })
})

describe('список скиллов', () => {
  const usage = {
    totalSkills: 3,
    includedSkills: 3,
    tokens: 900,
    skillFrontmatter: [
      { name: 'cheap', source: 'built-in', tokens: 100 },
      { name: 'dear', source: 'userSettings', tokens: 800 }
    ]
  }

  it('дорогие сверху: список — это очередь на разговор о цене', () => {
    expect(skillsFrom(usage)?.items.map((s) => s.name)).toEqual(['dear', 'cheap'])
  })

  it('состояние подмешано из настроек', () => {
    const s = skillsFrom(usage, { user: { dear: 'name-only' } })
    expect(s?.items[0]).toMatchObject({ name: 'dear', state: 'name-only', from: 'user' })
    expect(s?.items[1]).toMatchObject({ name: 'cheap', state: 'on' })
  })

  it('выключенный скилл движок не присылает — достаём из настроек, иначе не вернуть', () => {
    const s = skillsFrom(usage, { user: { 'legacy-context': 'off' } })
    const row = s?.items.find((x) => x.name === 'legacy-context')
    expect(row).toMatchObject({ state: 'off', tokens: 0, from: 'user' })
  })

  it('выключенные уходят вниз — разговор здесь про то, за что платится сейчас', () => {
    const s = skillsFrom(usage, { user: { zzz: 'off' } })
    expect(s?.items.at(-1)?.name).toBe('zzz')
  })

  it('скилл, который движок прислал, не дублируется строкой из настроек', () => {
    const s = skillsFrom(usage, { user: { dear: 'name-only' } })
    expect(s?.items.filter((x) => x.name === 'dear')).toHaveLength(1)
  })

  it('«on» в настройках лишней строки не создаёт', () => {
    const s = skillsFrom(usage, { user: { unknown: 'on' } })
    expect(s?.items.some((x) => x.name === 'unknown')).toBe(false)
  })

  it('пустого ответа не выдумываем', () => {
    expect(skillsFrom(undefined)).toBeUndefined()
    expect(skillsFrom({})).toBeUndefined()
  })
})

describe('плагинные скиллы', () => {
  it('опознаются по источнику', () => {
    expect(isPluginSkill('plugin')).toBe(true)
    expect(isPluginSkill('userSettings')).toBe(false)
  })

  it('имя плагина берётся до двоеточия', () => {
    expect(pluginOf('cloudflare:email-service')).toBe('cloudflare')
    expect(pluginOf('dataviz')).toBeUndefined()
  })

  it('команда отключения копируется как есть — имя с пробелом в кавычках', () => {
    expect(pluginDisableCommand('cloudflare')).toBe('claude plugin disable cloudflare')
    expect(pluginDisableCommand('my plugin')).toBe('claude plugin disable "my plugin"')
  })
})

describe('источник словами', () => {
  it('известные переводятся, незнакомый показывается как есть', () => {
    expect(sourceLabel('built-in')).toBe('встроенный')
    expect(sourceLabel('userSettings')).toBe('личный')
    expect(sourceLabel('enterpriseThing')).toBe('enterpriseThing')
  })
})
