// The §3 rendering rule (K1). Before this, "solid = fact, dashed = inferred"
// existed only on the phase ribbon and was decided by which array a band came
// from — nothing could assert that an inferred EVENT renders differently from
// an observed one. RedLog never blocks, so a suggestion that presents as a
// recorded fact is the whole §3 guarantee failing silently.

import { describe, it, expect } from 'vitest'
import { dotShape, isInferredEvent } from '../src/renderer/src/lib/dotShape'

const ev = (agentType: string, data: Record<string, unknown> = {}): { agentType: string; data: Record<string, unknown> } =>
  ({ agentType, data })

describe('isInferredEvent', () => {
  it('reads the stamp insertEvent wrote — it does not re-derive the classification', () => {
    expect(isInferredEvent(ev('loot', { authority: 'inferred' }))).toBe(true)
    // No stamp means fact, even for a type whose default IS inferred: the
    // renderer must not keep a second copy of the table (that is the drift K1
    // exists to end). An unstamped loot row is a row core did not classify.
    expect(isInferredEvent(ev('loot', {}))).toBe(false)
    expect(isInferredEvent(ev('shell', { authority: 'fact' }))).toBe(false)
  })

  it('ignores junk rather than treating it as a claim', () => {
    expect(isInferredEvent(ev('loot', { authority: 'maybe' }))).toBe(false)
    expect(isInferredEvent({ agentType: 'loot' })).toBe(false)
  })
})

describe('dotShape — shape and authority are orthogonal', () => {
  it('keeps the existing shape vocabulary unchanged', () => {
    expect(dotShape(ev('system', { subtype: 'scope_violation' })).shape).toBe('diamond')
    expect(dotShape(ev('marker', { severity: 'critical' })).shape).toBe('ring')
    expect(dotShape(ev('marker', { severity: 'important' })).scale).toBe(1.25)
    expect(dotShape(ev('shell', { subtype: 'command_end' })).shape).toBe('circle')
  })

  // The same glyph, two stroke styles: a scope violation is a diamond whether
  // it is an excluded-target FACT or a proximity INFERENCE.
  it('carries the tier alongside the shape, not instead of it', () => {
    const fact = dotShape(ev('system', { subtype: 'scope_violation', reason: 'excluded_target', authority: 'fact' }))
    const inferred = dotShape(ev('system', { subtype: 'scope_violation', reason: 'adjacent_subnet', authority: 'inferred' }))
    expect(fact.shape).toBe('diamond')
    expect(inferred.shape).toBe('diamond')
    expect(fact.inferred).toBe(false)
    expect(inferred.inferred).toBe(true)
  })

  it('marks a detector-derived event as inferred at every shape', () => {
    expect(dotShape(ev('loot', { authority: 'inferred' })).inferred).toBe(true)
    expect(dotShape(ev('pivot', { authority: 'inferred' })).inferred).toBe(true)
  })

  it('leaves observed capture solid', () => {
    for (const t of ['shell', 'http', 'screenshot', 'agent', 'marker']) {
      expect(dotShape(ev(t)).inferred).toBe(false)
    }
  })
})
