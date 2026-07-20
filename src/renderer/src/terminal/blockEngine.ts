import type { IDisposable, IMarker, Terminal } from '@xterm/xterm'
import type { BlockRecord } from '@shared/types'
import { uid } from '@/lib/uid'
import { emitBus } from '@/lib/bus'
import { useBlocksStore } from '@/state/blocksStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { getSettings } from '@/state/settingsStore'
import { formatDuration } from '@/lib/ansi'
import { pushRecentCommand } from './historyCache'

const OUTPUT_CAP = 100_000
const OUTPUT_LINES_CAP = 600

type Phase = 'preamble' | 'prompt' | 'input' | 'running'

/**
 * Turns shell-integration OSC marks into Warp-style command blocks.
 * Protocols understood: OSC 133 (A/B/C/D), OSC 7 / 9;9 / 1337 (cwd),
 * OSC 6973;E (Zarya command line + nonce), OSC 633 (VS Code compat).
 */
export class BlockEngine {
  readonly sessionId: string
  private term: Terminal
  private disposables: IDisposable[] = []
  private markers = new Map<string, IMarker>()
  private decorations: IDisposable[] = []
  private badgeEls = new Map<string, HTMLElement>()

  private phase: Phase = 'preamble'
  private currentBlockId: string | null = null
  private currentMarker: IMarker | null = null
  private currentStartedAt = 0
  private currentCommand = ''
  private cwd = ''

  /** Called on phase transitions (ghost-suggest input tracking). */
  onPhaseChange: ((phase: Phase) => void) | null = null

  constructor(term: Terminal, sessionId: string, initialCwd: string) {
    this.term = term
    this.sessionId = sessionId
    this.cwd = initialCwd

    const osc = (id: number, cb: (data: string) => boolean): void => {
      this.disposables.push(term.parser.registerOscHandler(id, cb))
    }

    osc(133, (data) => {
      this.handle133(data)
      return true
    })
    osc(633, (data) => {
      this.handle633(data)
      return true
    })
    osc(6973, (data) => {
      this.handle6973(data)
      return true
    })
    osc(7, (data) => {
      const p = parseFileUrl(data)
      if (p) this.setCwd(p)
      return true
    })
    osc(9, (data) => {
      // Windows Terminal style: 9;9;"C:\path"
      if (data.startsWith('9;')) {
        const p = data.slice(2).replace(/^"|"$/g, '')
        if (p) this.setCwd(p)
        return true
      }
      return false
    })
    osc(1337, (data) => {
      if (data.startsWith('CurrentDir=')) {
        this.setCwd(data.slice('CurrentDir='.length))
        return true
      }
      return false
    })
  }

  get currentCwd(): string {
    return this.cwd
  }

  get inputPhase(): boolean {
    return this.phase === 'input'
  }

  private expectedNonce(): string | undefined {
    return useSessionsStore.getState().sessions[this.sessionId]?.nonce
  }

  private setCwd(path: string): void {
    if (!path || path === this.cwd) return
    this.cwd = path
    emitBus('terminal:cwd-changed', { sessionId: this.sessionId, cwd: path })
  }

  // -------------------------------------------------------------- protocol

  private handle133(data: string): void {
    const cmd = data[0]
    const rest = data.length > 2 ? data.slice(2) : ''
    switch (cmd) {
      case 'A':
        this.onPromptStart()
        break
      case 'B':
        this.setPhase('input')
        break
      case 'C':
        this.onCommandExecuted()
        break
      case 'D':
        this.onCommandFinished(rest)
        break
    }
  }

  private handle633(data: string): void {
    const cmd = data[0]
    if (cmd === 'A' || cmd === 'B' || cmd === 'C' || cmd === 'D') {
      this.handle133(data)
      return
    }
    if (cmd === 'E') {
      // 633;E;<escaped-cmdline>[;<nonce>] — VS Code escaping: \xHH, \\
      const parts = data.slice(2).split(';')
      const raw = parts[0] ?? ''
      const text = raw
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) =>
          String.fromCharCode(parseInt(h, 16))
        )
        .replace(/\\\\/g, '\\')
      this.setCommandText(text, parts[1])
      return
    }
    if (data.startsWith('P;Cwd=')) {
      this.setCwd(data.slice('P;Cwd='.length))
    }
  }

  private handle6973(data: string): void {
    // E;<base64 command>;<nonce>
    if (!data.startsWith('E;')) return
    const [b64, nonce] = data.slice(2).split(';')
    let text = ''
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      text = new TextDecoder().decode(bytes)
    } catch {
      return
    }
    this.setCommandText(text, nonce)
  }

  private setCommandText(text: string, nonce?: string): void {
    const expected = this.expectedNonce()
    if (expected && nonce !== expected) {
      // Output printed a forged sequence — ignore the command text.
      return
    }
    this.currentCommand = text.trim()
    if (this.currentBlockId) {
      useBlocksStore
        .getState()
        .updateBlock(this.sessionId, this.currentBlockId, { command: this.currentCommand })
    }
  }

  private setPhase(p: Phase): void {
    if (this.phase === p) return
    this.phase = p
    this.onPhaseChange?.(p)
  }

  private onPromptStart(): void {
    if (this.phase === 'running' && this.currentBlockId) {
      // Prompt appeared without a D mark (rare) — close the block without code.
      this.finalizeBlock(undefined)
    }
    this.setPhase('prompt')
    if (getSettings().blocks.enabled && getSettings().blocks.separators) {
      this.addSeparator()
    }
  }

  private onCommandExecuted(): void {
    if (this.phase === 'running') return // duplicate C
    this.setPhase('running')
    if (!getSettings().blocks.enabled) return
    const id = uid('b')
    this.currentBlockId = id
    this.currentStartedAt = Date.now()
    this.currentCommand = ''
    try {
      this.currentMarker = this.term.registerMarker(0)
      if (this.currentMarker) this.markers.set(id, this.currentMarker)
    } catch {
      this.currentMarker = null
    }
    const block: BlockRecord = {
      id,
      sessionId: this.sessionId,
      command: '',
      cwd: this.cwd,
      startedAt: this.currentStartedAt,
      output: '',
      outputTruncated: false
    }
    useBlocksStore.getState().addBlock(block)
    this.addBadge(id)
  }

  private onCommandFinished(exitRaw: string): void {
    if (!this.currentBlockId) {
      this.setPhase('prompt')
      return
    }
    const exitCode = exitRaw === '' ? undefined : parseInt(exitRaw, 10)
    this.finalizeBlock(Number.isNaN(exitCode as number) ? undefined : exitCode)
  }

  private finalizeBlock(exitCode: number | undefined): void {
    const blockId = this.currentBlockId
    if (!blockId) return
    this.currentBlockId = null
    const endedAt = Date.now()
    const { output, truncated } = this.extractOutput()

    useBlocksStore.getState().updateBlock(this.sessionId, blockId, {
      exitCode,
      endedAt,
      output,
      outputTruncated: truncated
    })
    this.fillBadge(blockId, exitCode, endedAt - this.currentStartedAt)

    const command = this.currentCommand
    if (command) {
      pushRecentCommand(command)
      const session = useSessionsStore.getState().sessions[this.sessionId]
      void window.zarya.history.add({
        id: uid('h'),
        command,
        cwd: this.cwd,
        sessionId: this.sessionId,
        shellName: session?.shellName ?? '',
        exitCode,
        at: this.currentStartedAt
      })
    }
    emitBus('block:finished', { sessionId: this.sessionId, blockId, exitCode })
    this.currentMarker = null
  }

  private extractOutput(): { output: string; truncated: boolean } {
    const marker = this.currentMarker
    if (!marker || marker.isDisposed || marker.line < 0) {
      return { output: '', truncated: false }
    }
    try {
      const buf = this.term.buffer.normal
      const end = buf.baseY + buf.cursorY
      const start = marker.line
      const lines: string[] = []
      let truncated = false
      const from = Math.max(start, end - OUTPUT_LINES_CAP)
      if (from > start) truncated = true
      for (let i = from; i < end; i++) {
        const line = buf.getLine(i)
        if (!line) continue
        lines.push(line.translateToString(true))
      }
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      let output = lines.join('\n')
      if (output.length > OUTPUT_CAP) {
        output = output.slice(-OUTPUT_CAP)
        truncated = true
      }
      return { output, truncated }
    } catch {
      return { output: '', truncated: false }
    }
  }

  // ----------------------------------------------------------- decorations

  private addSeparator(): void {
    try {
      const marker = this.term.registerMarker(0)
      if (!marker) return
      const deco = this.term.registerDecoration({ marker, width: this.term.cols })
      if (!deco) return
      deco.onRender((el) => {
        el.classList.add('zy-block-sep')
      })
      this.decorations.push(deco)
    } catch {
      // decorations are cosmetic
    }
  }

  private addBadge(blockId: string): void {
    if (!getSettings().blocks.exitBadges) return
    try {
      const marker = this.currentMarker
      if (!marker) return
      const deco = this.term.registerDecoration({ marker, x: 0 })
      if (!deco) return
      deco.onRender((el) => {
        el.classList.add('zy-exit-badge', 'zy-exit-badge--running')
        if (!el.textContent) el.textContent = '⋯'
        this.badgeEls.set(blockId, el)
      })
      this.decorations.push(deco)
    } catch {
      // cosmetic
    }
  }

  private fillBadge(blockId: string, exitCode: number | undefined, durationMs: number): void {
    const el = this.badgeEls.get(blockId)
    if (!el) return
    el.classList.remove('zy-exit-badge--running')
    if (exitCode === undefined) {
      el.textContent = `· ${formatDuration(durationMs)}`
    } else if (exitCode === 0) {
      el.classList.add('zy-exit-badge--ok')
      el.textContent = `✓ ${formatDuration(durationMs)}`
    } else {
      el.classList.add('zy-exit-badge--fail')
      el.textContent = `✗ ${exitCode} · ${formatDuration(durationMs)}`
    }
  }

  // ------------------------------------------------------------ navigation

  scrollToBlock(blockId: string): void {
    const marker = this.markers.get(blockId)
    if (!marker || marker.isDisposed || marker.line < 0) return
    // Show a bit of context above the first output line (the command itself).
    this.term.scrollToLine(Math.max(0, marker.line - 2))
  }

  /** Jump to previous/next block relative to the viewport position. */
  jumpBlock(dir: 1 | -1): void {
    const blocks = useBlocksStore.getState().bySession[this.sessionId] ?? []
    const viewTop = this.term.buffer.active.viewportY
    const lines = blocks
      .map((b) => ({ b, line: this.markers.get(b.id)?.line ?? -1 }))
      .filter((x) => x.line >= 0)
      .sort((a, x) => a.line - x.line)
    if (!lines.length) return
    if (dir === -1) {
      const prev = [...lines].reverse().find((x) => x.line < viewTop + 1)
      this.scrollToBlock((prev ?? lines[0]).b.id)
    } else {
      const next = lines.find((x) => x.line > viewTop + 2)
      if (next) this.scrollToBlock(next.b.id)
      else this.term.scrollToBottom()
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    for (const d of this.decorations) d.dispose()
    this.disposables = []
    this.decorations = []
    this.markers.clear()
    this.badgeEls.clear()
  }
}

function parseFileUrl(data: string): string | null {
  if (!data.startsWith('file://')) return null
  try {
    const withoutScheme = data.slice('file://'.length)
    const slash = withoutScheme.indexOf('/')
    if (slash < 0) return null
    let path = decodeURIComponent(withoutScheme.slice(slash))
    // /C:/Users/x -> C:\Users\x on Windows-style paths
    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1).replace(/\//g, '\\')
    }
    return path
  } catch {
    return null
  }
}
