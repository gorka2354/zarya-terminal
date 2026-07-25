/**
 * Who is allowed to move a session's working directory.
 *
 * SECURITY: the cwd is a trust boundary, not a breadcrumb — it is handed to the
 * agent as its working directory and becomes the root the ACP filesystem proxy
 * confines reads and writes to. OSC 7 / 9;9 / 1337 / 633;P are ordinary output,
 * so ANY program (or `cat` of a crafted file) can print one and silently move
 * that root somewhere an attacker prepared.
 *
 * Our shell integration therefore also reports the cwd on a private channel
 * (OSC 6973;C) carrying a per-session nonce that never reaches child processes.
 * Once ONE valid nonced report has been seen we know the integration is live,
 * and every un-nonced report after it must be a forgery.
 *
 * The latch is what keeps this safe to ship: a session always has a nonce, but
 * not every shell runs our integration (cmd.exe and custom profiles do not).
 * Demanding the nonce unconditionally would freeze cwd tracking there outright.
 * With the latch, an un-integrated shell behaves exactly as it did before, and
 * an integrated one rejects forgeries — no configuration, no regression.
 */
export interface CwdReport {
  /** The session's nonce, if it has one. */
  expectedNonce?: string
  /** Nonce carried by this report (absent for plain OSC 7 / 9;9 / 1337 / 633;P). */
  nonce?: string
  /** Whether a valid nonced report has already been seen on this session. */
  trustedSeen: boolean
}

export interface CwdVerdict {
  /** Apply this report. */
  accept: boolean
  /** This report proves the integration is live — latch it. */
  trusted: boolean
}

export function cwdReportVerdict(r: CwdReport): CwdVerdict {
  const trusted = !!r.expectedNonce && r.nonce === r.expectedNonce
  if (trusted) return { accept: true, trusted: true }
  // Un-nonced: only believable until the trusted channel has proven itself.
  return { accept: !r.trustedSeen, trusted: false }
}
