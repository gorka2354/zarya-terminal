import { describe, expect, it } from 'vitest'
import { gateLabel, orphanGates } from '@/features/ai/gates'
import type { Conversation, PendingTool } from '@/features/ai/aiStore'

/**
 * Regression guard for a confirmed HIGH finding: approval gates raised by
 * Codex / Gemini / Kimi / Qwen had no card anywhere, yet Enter still approved
 * them — a blind yes to a command the user never saw. Every gate the keyboard
 * can approve (`!settled && kind !== 'question'`) must be returned here so a
 * surface can render it.
 */
const gate = (over: Partial<PendingTool> = {}): PendingTool =>
  ({
    id: 'p1',
    name: 'Bash',
    input: { command: 'rm -rf /' },
    autoApproved: false,
    settled: false,
    kind: 'run',
    ...over
  }) as PendingTool

const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1',
    messages: [],
    pendingTools: [],
    streaming: false,
    ...over
  }) as unknown as Conversation

describe('orphanGates', () => {
  it('surfaces a gate that no tool_use block describes (Codex / ACP engines)', () => {
    const c = conv({ pendingTools: [gate()] })
    expect(orphanGates(c).map((t) => t.id)).toEqual(['p1'])
  })

  it('skips a gate already described by a tool_use block (Claude Code)', () => {
    const c = conv({
      pendingTools: [gate()],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: {} }]
        }
      ] as unknown as Conversation['messages']
    })
    expect(orphanGates(c)).toEqual([])
  })

  it('skips settled gates — they are executing, not awaiting a decision', () => {
    const c = conv({ pendingTools: [gate({ settled: true })] })
    expect(orphanGates(c)).toEqual([])
  })

  it('covers EVERY gate the Enter shortcut can approve', () => {
    // Mirrors AgentBar's selection: find(t => !t.settled && t.kind !== 'question')
    const pendingTools = [
      gate({ id: 'a', settled: true }),
      gate({ id: 'b', kind: 'question' }),
      gate({ id: 'c' })
    ]
    const c = conv({ pendingTools })
    const approvableByKeyboard = pendingTools.filter((t) => !t.settled && t.kind !== 'question')
    const rendered = new Set(orphanGates(c).map((t) => t.id))
    for (const t of approvableByKeyboard) expect(rendered.has(t.id)).toBe(true)
  })

  it('handles several waiting gates at once', () => {
    const c = conv({ pendingTools: [gate({ id: 'x' }), gate({ id: 'y' })] })
    expect(orphanGates(c).map((t) => t.id)).toEqual(['x', 'y'])
  })
})

describe('gateLabel', () => {
  it('shows the command itself when there is one', () => {
    expect(gateLabel(gate({ input: { command: 'git push --force' } }))).toBe('git push --force')
  })

  it('names the file for edit-style tools', () => {
    expect(gateLabel(gate({ name: 'Edit', input: { file_path: '/tmp/a.ts' } }))).toBe(
      'Edit · /tmp/a.ts'
    )
    expect(gateLabel(gate({ name: 'Read', input: { path: '/tmp/b.ts' } }))).toBe('Read · /tmp/b.ts')
  })

  it('falls back to the driver title, then the tool name', () => {
    expect(gateLabel(gate({ input: {}, title: 'Записать файл' }))).toBe('Записать файл')
    expect(gateLabel(gate({ input: {}, name: 'Fetch' }))).toBe('Fetch')
  })

  it('never returns an empty label — an unlabelled gate is as blind as none', () => {
    expect(gateLabel(gate({ input: null, name: '', title: '', displayName: '' }))).toBeTruthy()
    expect(gateLabel(gate({ input: { command: '   ' }, name: '' }))).toBeTruthy()
  })
})
