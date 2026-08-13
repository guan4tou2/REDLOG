import { describe, it, expect } from 'vitest'
import { pinScore, isPinned, PIN_TIER, PIN_THRESHOLD } from '../src/core/artifact-pin'

// Pin score (SPEC-SCOPE-AWARE-LIFECYCLE.md scope-as-pin). Decides which io
// bodies survive under disk pressure: pinned kept longest, unpinned evicted
// first. The invariant that matters most: evidence (marker/loot) and operator
// pins beat scope, so an out-of-scope body a finding cites is never evicted first.

const base = { scope: 'unknown' as const, referencedByMarkerOrLoot: false, operatorPinned: false }

describe('pinScore', () => {
  it('ranks by scope verdict: in_scope > unknown > out_of_scope > excluded', () => {
    expect(pinScore({ ...base, scope: 'in_scope' })).toBe(PIN_TIER.inScope)
    expect(pinScore({ ...base, scope: 'unknown' })).toBe(PIN_TIER.unknown)
    expect(pinScore({ ...base, scope: 'out_of_scope' })).toBe(PIN_TIER.outOfScope)
    expect(pinScore({ ...base, scope: 'excluded' })).toBe(PIN_TIER.excluded)
    // strict ordering
    expect(pinScore({ ...base, scope: 'in_scope' }))
      .toBeGreaterThan(pinScore({ ...base, scope: 'unknown' }))
    expect(pinScore({ ...base, scope: 'out_of_scope' }))
      .toBeGreaterThan(pinScore({ ...base, scope: 'excluded' }))
  })

  it('evidence beats scope — a marker/loot ref pins an out-of-scope body', () => {
    const outButCited = { scope: 'out_of_scope' as const, referencedByMarkerOrLoot: true, operatorPinned: false }
    expect(pinScore(outButCited)).toBe(PIN_TIER.markerLoot)
    expect(isPinned(outButCited)).toBe(true)
  })

  it('an explicit operator pin outranks everything, even excluded', () => {
    expect(pinScore({ scope: 'excluded', referencedByMarkerOrLoot: false, operatorPinned: true }))
      .toBe(PIN_TIER.operator)
  })
})

describe('isPinned (eviction gate)', () => {
  it('pins in_scope, marker/loot-cited, and operator-pinned bodies', () => {
    expect(isPinned({ ...base, scope: 'in_scope' })).toBe(true)
    expect(isPinned({ ...base, referencedByMarkerOrLoot: true })).toBe(true)
    expect(isPinned({ ...base, operatorPinned: true })).toBe(true)
  })

  it('leaves unknown / out_of_scope / excluded unpinned (evicted first)', () => {
    expect(isPinned({ ...base, scope: 'unknown' })).toBe(false)
    expect(isPinned({ ...base, scope: 'out_of_scope' })).toBe(false)
    expect(isPinned({ ...base, scope: 'excluded' })).toBe(false)
  })

  it('the threshold is the in_scope tier', () => {
    expect(PIN_THRESHOLD).toBe(PIN_TIER.inScope)
  })
})
