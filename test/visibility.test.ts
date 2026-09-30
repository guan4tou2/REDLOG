// What the interface says about an engagement that has captured nothing yet.
//
// This file used to test eleven disclosure gates — a sidebar page appearing
// once the record held the noun it was named after. That is gone, and what it
// cost is the reason: a hint line in the nav to explain the absence, a
// checkbox in Settings to undo it, a localStorage module, and two occasions on
// which the app's own author opened a fresh project and asked why the sidebar
// had three rows. Eleven rows was never worth that.
//
// Two derivations survive, and neither hides a way into anything.

import { describe, it, expect } from 'vitest'
import {
  computeVisibility, shouldRefetch, EMPTY_SIGNALS, type VisibilitySignals
} from '../src/renderer/src/lib/visibility'

const signals = (over: Partial<VisibilitySignals> = {}): VisibilitySignals =>
  ({ ...EMPTY_SIGNALS, ...over })

describe('first run', () => {
  it('is on until the record holds something that is not the app talking to itself', () => {
    expect(computeVisibility(EMPTY_SIGNALS).firstRun).toBe(true)
    expect(computeVisibility(signals({ evidenceSeen: true })).firstRun).toBe(false)
  })

  it('does not wait for a logged tier — a shell hook alone is capture', () => {
    // The two signals are independent. An operator with the shell hook wired
    // and no proxy has captured plenty, and telling them to get started would
    // be the app disbelieving its own record.
    expect(computeVisibility(signals({ evidenceSeen: true, loggedEver: false })).firstRun).toBe(false)
  })
})

describe('the tier chip', () => {
  it('appears only once the project has had two tiers to distinguish', () => {
    // A chip for a distinction that has never existed is noise, not
    // information — the Inspector would be labelling every row "chained" in a
    // project where chained is the only thing there is.
    expect(computeVisibility(EMPTY_SIGNALS).tierChip).toBe(false)
    expect(computeVisibility(signals({ loggedEver: true })).tierChip).toBe(true)
  })
})

describe('re-probing', () => {
  it('stops once both answers are in', () => {
    // A mature project must cost zero queries per batch. This is the guard.
    const done = signals({ evidenceSeen: true, loggedEver: true })
    expect(computeVisibility(done).complete).toBe(true)
    expect(shouldRefetch(done, [{ agentType: 'shell', tier: 'logged' }])).toBe(false)
  })

  it('ignores the app talking to itself, which is what evidenceSeen means', () => {
    expect(shouldRefetch(EMPTY_SIGNALS, [{ agentType: 'system' }])).toBe(false)
    expect(shouldRefetch(EMPTY_SIGNALS, [{ agentType: 'cleanup' }])).toBe(false)
    expect(shouldRefetch(EMPTY_SIGNALS, [{ agentType: 'shell' }])).toBe(true)
  })

  it('re-probes for a first logged row even when evidence is already in', () => {
    const seen = signals({ evidenceSeen: true })
    expect(shouldRefetch(seen, [{ agentType: 'scanner' }])).toBe(false)
    expect(shouldRefetch(seen, [{ agentType: 'scanner', tier: 'logged' }])).toBe(true)
  })

  it('does not care about an empty batch', () => {
    expect(shouldRefetch(EMPTY_SIGNALS, [])).toBe(false)
  })
})
