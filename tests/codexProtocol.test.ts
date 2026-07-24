import { describe, expect, it } from 'vitest'
import { codexEffort, codexModel } from '../src/main/codexProtocol'

describe('codexModel', () => {
  it('passes through Codex/OpenAI model ids', () => {
    expect(codexModel('gpt-5.1-codex')).toBe('gpt-5.1-codex')
    expect(codexModel('gpt-5.1')).toBe('gpt-5.1')
    expect(codexModel('o3')).toBe('o3')
    expect(codexModel('codex-mini')).toBe('codex-mini')
  })

  it('drops Claude model ids so the Codex account default applies', () => {
    expect(codexModel('opus')).toBeUndefined()
    expect(codexModel('claude-sonnet-5')).toBeUndefined()
    expect(codexModel('sonnet')).toBeUndefined()
    expect(codexModel('fable')).toBeUndefined()
  })

  it('treats empty/undefined as no override', () => {
    expect(codexModel(undefined)).toBeUndefined()
    expect(codexModel('')).toBeUndefined()
  })
})

describe('codexEffort', () => {
  it('passes through Codex three-level effort', () => {
    expect(codexEffort('low')).toBe('low')
    expect(codexEffort('medium')).toBe('medium')
    expect(codexEffort('high')).toBe('high')
  })

  it('clamps Claude-only tiers (incl. ultracode xhigh) to high', () => {
    expect(codexEffort('xhigh')).toBe('high')
    expect(codexEffort('max')).toBe('high')
  })

  it('drops unknown/empty values', () => {
    expect(codexEffort(undefined)).toBeUndefined()
    expect(codexEffort('')).toBeUndefined()
    expect(codexEffort('turbo')).toBeUndefined()
  })
})
