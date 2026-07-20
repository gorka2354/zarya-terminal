import type { BlockRecord } from '@shared/types'

/**
 * Bridge used by the terminal core to talk to the AI feature without a hard
 * dependency. The AI feature registers its implementation on load.
 */
export interface AiBridgeImpl {
  /** Open the AI panel and ask about a specific block (e.g. explain an error). */
  explainBlock: (block: BlockRecord, question?: string) => void
  /** Open the inline "natural language -> command" bar for a session. */
  openCommandBar: (sessionId: string) => void
  /** Open the AI panel. */
  openPanel: () => void
}

let impl: AiBridgeImpl | null = null

export function registerAiBridge(i: AiBridgeImpl): void {
  impl = i
}

export function aiExplainBlock(block: BlockRecord, question?: string): void {
  impl?.explainBlock(block, question)
}

export function aiOpenCommandBar(sessionId: string): void {
  impl?.openCommandBar(sessionId)
}

export function aiOpenPanel(): void {
  impl?.openPanel()
}
