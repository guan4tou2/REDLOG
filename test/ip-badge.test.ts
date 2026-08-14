// The shared display decision (G-A3). StatusBar, IPStatusCard and the overlay
// HUD style themselves differently but must never disagree about the verdict,
// so the decision lives in one pure function and is pinned here.

import { describe, it, expect } from 'vitest'
import { ipBadge } from '../src/renderer/src/lib/ip-badge'

describe('ipBadge', () => {
  it('a live verdict renders at full confidence', () => {
    expect(ipBadge({ ipSafety: 'safe' })).toEqual({ tone: 'safe', qualified: false, reason: null })
    expect(ipBadge({ ipSafety: 'exposed' })).toEqual({ tone: 'exposed', qualified: false, reason: null })
  })

  it('settling keeps the tone but qualifies it — the address is unconfirmed, the verdict is not dead', () => {
    expect(ipBadge({ ipSafety: 'safe', settling: true }))
      .toEqual({ tone: 'safe', qualified: true, reason: 'settling' })
  })

  it('stale forces unknown — a green badge must never outlive its reading', () => {
    expect(ipBadge({ ipSafety: 'safe', stale: true }))
      .toEqual({ tone: 'unknown', qualified: true, reason: 'stale' })
  })

  it('stale wins over settling: no reading is a stronger statement than an unconfirmed one', () => {
    expect(ipBadge({ ipSafety: 'exposed', settling: true, stale: true }))
      .toEqual({ tone: 'unknown', qualified: true, reason: 'stale' })
  })

  // Defensive: the main process already decays the verdict, but a surface must
  // not present green if the two ever drift apart.
  it('forces the tone rather than trusting a stale-but-undecayed status', () => {
    expect(ipBadge({ ipSafety: 'safe', stale: true }).tone).toBe('unknown')
  })

  it('no status at all is unknown, not qualified — nothing has expired yet', () => {
    expect(ipBadge(null)).toEqual({ tone: 'unknown', qualified: false, reason: null })
    expect(ipBadge(undefined)).toEqual({ tone: 'unknown', qualified: false, reason: null })
  })
})
