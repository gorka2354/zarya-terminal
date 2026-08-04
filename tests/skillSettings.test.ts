import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSettingsFile, readSkillOverrides, skillSettingsPaths } from '../src/main/skillSettings'

/**
 * Чтение ЧУЖОГО файла настроек — на настоящих файлах.
 *
 * Здесь проверяется то, из-за чего ревью нашло самую дорогую ошибку этого
 * инкремента: «файла нет» и «файл есть, но не читается» раньше давали один и
 * тот же ответ, а вызывающий подставлял пустой объект и записывал его поверх
 * конфига человека. Достаточно было BOM (его ставит PowerShell `Out-File
 * -Encoding utf8`) или висячей запятой, чтобы молча потерять модель, хуки и
 * плагины. Разница между этими двумя состояниями и есть предмет файла.
 */
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'zarya-sset-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не должна валить тест */
    }
  }
})

describe('«нет файла» и «не читается» — разные ответы', () => {
  it('отсутствующий файл — missing: писать поверх пустоты безопасно', () => {
    expect(readSettingsFile(join(tmp(), 'нет-такого.json')).kind).toBe('missing')
  })

  it('пустой файл — тоже missing: настроек в нём нет', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, '   \n')
    expect(readSettingsFile(f).kind).toBe('missing')
  })

  it('сломанный JSON — unreadable, а НЕ пустой объект', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, '{ "model": "opus",, }')
    const r = readSettingsFile(f)
    expect(r.kind).toBe('unreadable')
  })

  it('массив вместо объекта — unreadable: это чей-то файл со смыслом', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, '[1,2,3]')
    expect(readSettingsFile(f).kind).toBe('unreadable')
  })

  it('файл с BOM читается, а не отвергается — его пишет обычный PowerShell', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, '﻿{"model":"opus","hooks":{"PreToolUse":[1]}}')
    const r = readSettingsFile(f)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.value.model).toBe('opus')
  })

  it('здоровый файл отдаёт все ключи целиком', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, JSON.stringify({ model: 'opus', hooks: {}, skillOverrides: { a: 'off' } }))
    const r = readSettingsFile(f)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(Object.keys(r.value).sort()).toEqual(['hooks', 'model', 'skillOverrides'])
  })
})

describe('слои настроек', () => {
  const project = (): string => {
    const d = tmp()
    mkdirSync(join(d, '.claude'), { recursive: true })
    return d
  }

  it('без папки проекта проектные пути не выдумываются', () => {
    const p = skillSettingsPaths(undefined)
    expect(p.user).toContain('.claude')
    expect(p.project).toBeUndefined()
    expect(p.local).toBeUndefined()
  })

  it('настройка проекта читается', () => {
    const d = project()
    writeFileSync(
      join(d, '.claude', 'settings.json'),
      JSON.stringify({ skillOverrides: { deploy: 'name-only' } })
    )
    const { layers, broken } = readSkillOverrides(d)
    expect(layers.project).toEqual({ deploy: 'name-only' })
    expect(broken).toEqual([])
  })

  it('сломанный слой проекта отмечается, а не выдаётся за пустой', () => {
    const d = project()
    writeFileSync(join(d, '.claude', 'settings.json'), '{сломано')
    const { layers, broken } = readSkillOverrides(d)
    expect(layers.project).toBeUndefined()
    expect(broken).toContain('project')
  })

  it('отсутствующий слой сломанным НЕ считается', () => {
    const { broken } = readSkillOverrides(project())
    expect(broken).not.toContain('project')
    expect(broken).not.toContain('local')
  })

  it('локальный слой проекта тоже виден', () => {
    const d = project()
    writeFileSync(
      join(d, '.claude', 'settings.local.json'),
      JSON.stringify({ skillOverrides: { deploy: 'off' } })
    )
    expect(readSkillOverrides(d).layers.local).toEqual({ deploy: 'off' })
  })

  it('skillOverrides не-объект игнорируется, но файл сломанным не зовём', () => {
    const d = project()
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: 'ерунда' }))
    const { layers, broken } = readSkillOverrides(d)
    expect(layers.project).toBeUndefined()
    expect(broken).not.toContain('project')
  })
})
