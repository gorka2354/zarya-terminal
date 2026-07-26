import { describe, expect, it } from 'vitest'
import { nativeGateOpts } from '@/features/ai/startOpts'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AiSettings } from '@shared/types'

/**
 * Regression guard for a confirmed MEDIUM finding: `ai.autoApprove` — the built-in
 * agent's run_command switch — was sent to native drivers as
 * `permissionMode: 'acceptEdits'`, the Claude Agent SDK's "auto-accept file edit
 * operations". File edits then bypassed `canUseTool` entirely, below the app's
 * approval UI, while АВТОПИЛОТ was off and the bar read «РУЧНОЙ».
 *
 * The invariant: a native gate is weakened by АВТОПИЛОТ and by nothing else.
 */
const ai = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...DEFAULT_SETTINGS.ai,
  ...over
})

describe('nativeGateOpts', () => {
  it('never derives a permission mode from autoApprove', () => {
    for (const autoApprove of [true, false])
      expect(nativeGateOpts(ai({ autoApprove })).permissionMode).toBe('default')
  })

  it("never sends 'acceptEdits' — it removes the file-edit gate below canUseTool", () => {
    for (const autoApprove of [true, false])
      for (const claudeBypass of [true, false])
        expect(nativeGateOpts(ai({ autoApprove, claudeBypass })).permissionMode).not.toBe(
          'acceptEdits'
        )
  })

  it('weakens the gate only through АВТОПИЛОТ', () => {
    expect(nativeGateOpts(ai({ autoApprove: true, claudeBypass: false })).bypass).toBe(false)
    expect(nativeGateOpts(ai({ autoApprove: false, claudeBypass: true })).bypass).toBe(true)
  })

  it('is closed by default', () => {
    const d = nativeGateOpts(DEFAULT_SETTINGS.ai)
    expect(d).toEqual({ permissionMode: 'default', bypass: false })
  })
})
