// The shared display decision (G-A3). StatusBar, IPStatusCard and the overlay
// HUD style themselves differently but must never disagree about the verdict,
// so the decision lives in one pure function and is pinned here.

import { describe, it, expect } from 'vitest'
import { ipBadge } from '../src/renderer/src/lib/ip-badge'

describe('ipBadge', () => {
  it('a live verdict renders at full confidence', () => {
    expect(ipBadge({ ipSafety: 'safe' })).toEqual({ severity: 'ok', qualified: false, reason: null })
    expect(ipBadge({ ipSafety: 'exposed' })).toEqual({ severity: 'critical', qualified: false, reason: null })
  })

  it('settling keeps the severity but qualifies it — the address is unconfirmed, the verdict is not dead', () => {
    expect(ipBadge({ ipSafety: 'safe', settling: true }))
      .toEqual({ severity: 'ok', qualified: true, reason: 'settling' })
  })

  it('stale forces unknown severity — a green badge must never outlive its reading', () => {
    expect(ipBadge({ ipSafety: 'safe', stale: true }))
      .toEqual({ severity: 'unknown', qualified: true, reason: 'stale' })
  })

  it('stale wins over settling: no reading is a stronger statement than an unconfirmed one', () => {
    expect(ipBadge({ ipSafety: 'exposed', settling: true, stale: true }))
      .toEqual({ severity: 'unknown', qualified: true, reason: 'stale' })
  })

  // Defensive: the main process already decays the verdict, but a surface must
  // not present green if the two ever drift apart.
  it('forces the severity rather than trusting a stale-but-undecayed status', () => {
    expect(ipBadge({ ipSafety: 'safe', stale: true }).severity).toBe('unknown')
  })

  it('no status at all is unknown, not qualified — nothing has expired yet', () => {
    expect(ipBadge(null)).toEqual({ severity: 'unknown', qualified: false, reason: null })
    expect(ipBadge(undefined)).toEqual({ severity: 'unknown', qualified: false, reason: null })
  })
})

// G-A2 meets G-A3 meets G-C1: five verdicts, four SHARED severity steps (the
// scope alarm uses the same four). `presumed_safe` sits on `ok` like `safe` and
// is separated by `qualified`, so a surface paints four colours rather than five
// — and an inference can never render as a solid green fill.
describe('ipBadge — the five verdicts', () => {
  it('gives off_profile its own severity step, unqualified — it is an observation', () => {
    expect(ipBadge({ ipSafety: 'off_profile' }))
      .toEqual({ severity: 'warn', qualified: false, reason: null })
  })

  it('folds presumed_safe onto the ok step but never at full confidence', () => {
    expect(ipBadge({ ipSafety: 'presumed_safe' }))
      .toEqual({ severity: 'ok', qualified: true, reason: 'presumed' })
  })

  it('a verified safe stays unqualified — the two must not look alike', () => {
    const verified = ipBadge({ ipSafety: 'safe' })
    const presumed = ipBadge({ ipSafety: 'presumed_safe' })
    expect(verified.severity).toBe(presumed.severity)
    expect(verified.qualified).toBe(false)
    expect(presumed.qualified).toBe(true)
  })

  // Precedence runs from "how much do we know" outward: no reading beats an
  // unconfirmed reading beats a confirmed reading we can only infer from.
  it('a dead reading outranks an inference', () => {
    expect(ipBadge({ ipSafety: 'presumed_safe', stale: true }).reason).toBe('stale')
    expect(ipBadge({ ipSafety: 'presumed_safe', settling: true }).reason).toBe('settling')
  })

  it('off_profile survives settling with its own severity', () => {
    expect(ipBadge({ ipSafety: 'off_profile', settling: true }))
      .toEqual({ severity: 'warn', qualified: true, reason: 'settling' })
  })
})
