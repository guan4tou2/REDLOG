// The watchdog the chain never had.
//
// Capture health has been polled every thirty seconds since it existed. The
// chain was checked only when the operator pressed Verify in Settings, or
// happened to look at one tile on the dashboard — so a drifted chain, a dead
// anchor loop or a broken sample row could run the length of an engagement in
// silence. A capture outage costs the events it drops; a chain fault costs the
// defensibility of everything already written, and it is silent by nature:
// the record keeps growing and every screen keeps looking normal.
//
// The other half of this is restraint. A status-bar issue is pinned and
// undismissable, so anything that fires on a normal hiccup teaches the
// operator to ignore the one that matters.

import { describe, it, expect } from 'vitest'
import { integrityFault, ANCHOR_DEAD_HOURS, type IntegrityReading } from '../src/renderer/src/lib/integrityPulse'

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const hoursAgo = (h: number): number => NOW - h * 3_600_000

const reading = (over: Partial<IntegrityReading> = {}): IntegrityReading => ({
  chainLen: 100,
  eventCount: 100,
  lastAnchor: { createdAt: hoursAgo(1), status: 'complete' },
  sampleBroken: false,
  now: NOW,
  ...over
})

describe('a sound record', () => {
  it('raises nothing', () => {
    expect(integrityFault(reading())).toBeNull()
  })

  it('raises nothing for a project that has never anchored', () => {
    // Minutes old, or anchoring deliberately off. Alarming about the absence
    // of something nobody asked for is how a status bar teaches people to
    // stop reading it.
    expect(integrityFault(reading({ lastAnchor: null }))).toBeNull()
  })

  it('raises nothing for an anchor that is merely late', () => {
    // The dashboard tints two hours amber. An alarm that fires on a normal
    // calendar hiccup is worse than no alarm.
    expect(integrityFault(reading({ lastAnchor: { createdAt: hoursAgo(3), status: 'complete' } }))).toBeNull()
    expect(integrityFault(reading({
      lastAnchor: { createdAt: hoursAgo(ANCHOR_DEAD_HOURS - 1), status: 'complete' }
    }))).toBeNull()
  })
})

describe('faults', () => {
  it('catches a chain that no longer matches its rows', () => {
    const f = integrityFault(reading({ chainLen: 98, eventCount: 100 }))
    expect(f?.kind).toBe('chain-drift')
    expect(f?.vars).toEqual({ chain: 98, events: 100 })
  })

  it('catches drift in either direction', () => {
    // More hashes than rows is as wrong as fewer, and it is the direction a
    // deletion produces.
    expect(integrityFault(reading({ chainLen: 102, eventCount: 100 }))?.kind).toBe('chain-drift')
  })

  it('catches a row that failed its own verification', () => {
    expect(integrityFault(reading({ sampleBroken: true }))?.kind).toBe('sample-broken')
  })

  it('catches a failed anchor whatever its age', () => {
    const f = integrityFault(reading({ lastAnchor: { createdAt: hoursAgo(0), status: 'failed' } }))
    expect(f?.kind).toBe('anchor-failed')
  })

  it('catches an anchor loop that has been dead a day', () => {
    const f = integrityFault(reading({
      lastAnchor: { createdAt: hoursAgo(ANCHOR_DEAD_HOURS), status: 'complete' }
    }))
    expect(f?.kind).toBe('anchor-stale')
    expect(f?.vars.days).toBe(1)
  })

  it('counts the days, so a week is not reported as a day', () => {
    const f = integrityFault(reading({ lastAnchor: { createdAt: hoursAgo(24 * 7), status: 'complete' } }))
    expect(f?.vars.days).toBe(7)
  })
})

describe('which fault, when there are several', () => {
  it('reports drift over everything else', () => {
    // The status bar is one line and the operator acts on one thing. Drift
    // means the record cannot be walked at all, which makes every other
    // question about it moot.
    const f = integrityFault(reading({
      chainLen: 98,
      sampleBroken: true,
      lastAnchor: { createdAt: hoursAgo(72), status: 'failed' }
    }))
    expect(f?.kind).toBe('chain-drift')
  })

  it('reports a broken sample over an anchor problem', () => {
    const f = integrityFault(reading({
      sampleBroken: true,
      lastAnchor: { createdAt: hoursAgo(72), status: 'failed' }
    }))
    expect(f?.kind).toBe('sample-broken')
  })

  it('reports a failed anchor over a stale one', () => {
    const f = integrityFault(reading({ lastAnchor: { createdAt: hoursAgo(72), status: 'failed' } }))
    expect(f?.kind).toBe('anchor-failed')
  })
})
