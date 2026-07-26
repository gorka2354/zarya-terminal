import { describe, expect, it } from 'vitest'
import { GATE_HEAD_CHARS, gateLabel, gateView, orphanGates, toolLabel } from '@/features/ai/gates'
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

/**
 * Regression guard for a confirmed MEDIUM finding: the side panel labelled gates
 * from `input.command` alone, so an Edit/Write gate rendered as «—» — an approval
 * prompt describing nothing. One label function now serves every surface.
 */
describe('toolLabel', () => {
  it('describes a file tool even with no command field', () => {
    expect(toolLabel('Edit', { file_path: '/etc/hosts' })).toBe('Edit · /etc/hosts')
    expect(toolLabel('Read', { path: '/tmp/b.ts' })).toBe('Read · /tmp/b.ts')
  })

  it('describes an ACP gate, whose only human text is input.title / displayName', () => {
    // Gemini/Kimi/Qwen send no top-level title and no command/path in the input —
    // labelling from those alone decayed the card to a bare «Bash» / «Edit».
    const t = gate({
      name: 'Bash',
      input: { title: 'rm -rf build && git checkout -- .', kind: 'execute' },
      displayName: 'rm -rf build && git checkout -- .',
      title: undefined
    })
    expect(gateLabel(t)).toContain('rm -rf build')
    expect(gateLabel(t)).not.toBe('Bash')
  })

  it('labels the same gate identically wherever it is rendered', () => {
    // The feed labels from the PendingTool (gateLabel); a card without a gate
    // falls back to props. Both must agree on an ACP-shaped gate — this is the
    // case that used to diverge between the feed and the side panel.
    const t = gate({
      name: 'Edit',
      input: { title: 'Изменить src/main/ipc.ts', kind: 'edit' },
      displayName: 'Изменить src/main/ipc.ts',
      title: undefined
    })
    expect(toolLabel(t.name, t.input, t.title, t.displayName)).toBe(gateLabel(t))
    expect(gateLabel(t)).toBe('Изменить src/main/ipc.ts')
  })

  it('names the files in a Codex patch gate', () => {
    // Read-only sandboxing routes every in-project edit through this gate, so an
    // unlabelled one would be frequent AND indistinguishable from a patch to a
    // config outside the project. The driver puts the paths in input.title.
    const t = gate({
      name: 'ApplyPatch',
      input: { reason: null, title: 'Изменение файлов: src/main/ipc.ts, package.json' },
      displayName: 'Изменение файлов: src/main/ipc.ts, package.json',
      title: undefined
    })
    expect(gateLabel(t)).toContain('src/main/ipc.ts')
    expect(gateLabel(t)).not.toBe('ApplyPatch')
  })

  it('never renders as an empty prompt', () => {
    expect(toolLabel('', null)).toBeTruthy()
    expect(toolLabel('', { command: '  ' })).toBeTruthy()
  })
})

/**
 * Regression guard for a confirmed MEDIUM finding: cards folded any long or
 * multi-line command down to its first 88 characters, so the dangerous half sat
 * behind a fold while «ВЫПОЛНИТЬ» / Enter were one keystroke away.
 */
describe('gateView', () => {
  const long = 'x'.repeat(GATE_HEAD_CHARS + 10)
  const multi = 'cd /tmp\nrm -rf ./build\necho done'

  it('pins a long command open while it awaits a decision', () => {
    expect(gateView(long, true).mustShowFull).toBe(true)
    expect(gateView(multi, true).mustShowFull).toBe(true)
  })

  it('hides nothing dangerous below the fold: the tail line is a separate line', () => {
    const v = gateView(multi, true)
    // The header only ever shows line 1 — the pin is what puts `rm -rf` on screen.
    expect(v.firstLine).toBe('cd /tmp')
    expect(v.lines).toBe(3)
    expect(v.mustShowFull).toBe(true)
  })

  it('lets a settled card fold again — by then it is history, not a decision', () => {
    expect(gateView(long, false).mustShowFull).toBe(false)
    expect(gateView(multi, false).mustShowFull).toBe(false)
  })

  it('pins a SHORT command open too — the header line is narrower than the threshold', () => {
    // The header shares one flex row with the tool note and ellipsises around
    // half GATE_HEAD_CHARS (far less in a narrow window), so deciding by length
    // left a band of commands cut by CSS with no fold to open them.
    const v = gateView('rm -rf ./build && git clean -fdx', true)
    expect(v.isLong).toBe(false) // still folds once settled
    expect(v.mustShowFull).toBe(true) // but nothing is hidden while it asks
  })

  it('leaves a short single-line command foldable once settled', () => {
    const v = gateView('ls -la', false)
    expect(v.isLong).toBe(false)
    expect(v.mustShowFull).toBe(false)
    expect(v.label).toBe('ls -la')
    expect(v.lines).toBe(1)
  })

  it('marks the collapsed label as truncated so it never reads as the whole command', () => {
    expect(gateView(long, false).label).not.toBe(long)
    expect(gateView(long, false).label.endsWith('…')).toBe(true)
    expect(gateView(multi, false).label.endsWith('⋯')).toBe(true)
  })

  it('does not double up the ellipsis on a long single line', () => {
    expect(gateView(long, false).label.endsWith('……')).toBe(false)
  })

  it('does not count a trailing newline as a second line', () => {
    const v = gateView('npm run build\n', true)
    expect(v.lines).toBe(1)
    expect(v.isLong).toBe(false)
    expect(v.firstLine).toBe('npm run build')
  })

  it('a blank command has nothing to pin', () => {
    expect(gateView('   ', true).mustShowFull).toBe(false)
  })

  it('treats a command exactly at the header width as short', () => {
    const exact = 'y'.repeat(GATE_HEAD_CHARS)
    expect(gateView(exact, true).isLong).toBe(false)
    expect(gateView(exact + 'y', true).isLong).toBe(true)
  })

  it('handles an empty command without crashing the card', () => {
    const v = gateView('', true)
    expect(v.isLong).toBe(false)
    expect(v.firstLine).toBe('')
    expect(v.lines).toBe(1)
  })
})
