import { describe, expect, it } from 'vitest'
import { cwdReportVerdict } from '@/terminal/cwdTrust'

/**
 * Regression guard for a confirmed HIGH finding: the session cwd — which becomes
 * the agent's working directory and the root its filesystem access is confined
 * to — was tracked from plain OSC sequences, so any program's output could move
 * it. Our integration now reports it with a per-session nonce.
 */
const NONCE = 'a'.repeat(32)

describe('cwdReportVerdict', () => {
  it('accepts and latches a correctly nonced report', () => {
    expect(cwdReportVerdict({ expectedNonce: NONCE, nonce: NONCE, trustedSeen: false })).toEqual({
      accept: true,
      trusted: true
    })
  })

  it('rejects an un-nonced report once the trusted channel has proven itself', () => {
    expect(cwdReportVerdict({ expectedNonce: NONCE, trustedSeen: true })).toEqual({
      accept: false,
      trusted: false
    })
  })

  it('rejects a WRONG nonce after latching (a guessed forgery)', () => {
    expect(cwdReportVerdict({ expectedNonce: NONCE, nonce: 'guess', trustedSeen: true })).toEqual({
      accept: false,
      trusted: false
    })
  })

  it('still honours plain OSC 7 when no integration ever reported (cmd.exe, custom profiles)', () => {
    // The latch is what keeps un-integrated shells working exactly as before —
    // demanding the nonce unconditionally would freeze cwd tracking there.
    expect(cwdReportVerdict({ expectedNonce: NONCE, trustedSeen: false })).toEqual({
      accept: true,
      trusted: false
    })
    expect(cwdReportVerdict({ trustedSeen: false })).toEqual({ accept: true, trusted: false })
  })

  it('never latches on a session that has no nonce at all', () => {
    expect(cwdReportVerdict({ nonce: 'anything', trustedSeen: false }).trusted).toBe(false)
  })

  it('never latches on a mismatched nonce', () => {
    expect(cwdReportVerdict({ expectedNonce: NONCE, nonce: 'nope', trustedSeen: false })).toEqual({
      accept: true,
      trusted: false
    })
  })

  it('once latched, stays closed for every subsequent un-nonced report', () => {
    let latched = false
    const feed = (nonce?: string): boolean => {
      const v = cwdReportVerdict({ expectedNonce: NONCE, nonce, trustedSeen: latched })
      if (v.trusted) latched = true
      return v.accept
    }
    expect(feed(NONCE)).toBe(true) // integration reports first (at the prompt)
    expect(feed(undefined)).toBe(false) // forged OSC 7 printed by a command
    expect(feed('x')).toBe(false) // forged with a guessed nonce
    expect(feed(NONCE)).toBe(true) // the real integration keeps working
  })
})
