import { describe, it, expect } from 'vitest'
import { buildEffectsIndex, computeViolationStanding } from '../src/renderer/src/lib/timelineAnnotations'
import type { RedLogEvent } from '../src/core/db/event-types'

function evt(id: string, agentType: string, data: Record<string, unknown> = {}): RedLogEvent {
  return {
    id,
    timestamp: Date.now(),
    engagementId: 'eng-1',
    sessionId: 'ses-1',
    operatorId: 'op-1',
    agentType,
    hostname: 'localhost',
    sourceIP: null,
    targetId: null,
    data,
    hash: 'h',
    prevHash: null,
    createdAt: Date.now(),
  }
}

describe('buildEffectsIndex', () => {
  it('returns empty map for events without _causes', () => {
    const events = [evt('a', 'shell'), evt('b', 'shell')]
    expect(buildEffectsIndex(events).size).toBe(0)
  })

  it('maps cause ids to their effect event ids', () => {
    const events = [
      evt('a', 'shell'),
      evt('b', 'system', { _causes: ['a'] }),
      evt('c', 'scanner', { _causes: ['a', 'b'] }),
    ]
    const idx = buildEffectsIndex(events)
    expect(idx.get('a')).toEqual(['b', 'c'])
    expect(idx.get('b')).toEqual(['c'])
  })

  it('ignores non-string entries in _causes', () => {
    const events = [evt('x', 'shell', { _causes: [42, null, 'a'] })]
    const idx = buildEffectsIndex(events)
    expect(idx.get('a')).toEqual(['x'])
    expect(idx.size).toBe(1)
  })
})

describe('computeViolationStanding', () => {
  it('returns empty sets when no system events', () => {
    const { cleared, superseded } = computeViolationStanding([evt('a', 'shell')])
    expect(cleared.size).toBe(0)
    expect(superseded.size).toBe(0)
  })

  it('marks cleared violations', () => {
    const events = [
      evt('v1', 'system', { subtype: 'scope_violation', _causes: ['src1'] }),
      evt('c1', 'system', { subtype: 'scope_cleared', violation_id: 'v1' }),
    ]
    const { cleared } = computeViolationStanding(events)
    expect(cleared.has('v1')).toBe(true)
  })

  it('marks superseded violations (newest-first order)', () => {
    // events is newest-first: newer comes first in array
    const events = [
      evt('v2', 'system', { subtype: 'scope_violation', _causes: ['src1'] }),
      evt('v1', 'system', { subtype: 'scope_violation', _causes: ['src1'] }),
    ]
    const { superseded } = computeViolationStanding(events)
    // v2 is newest (first in array) → keeps; v1 is older → superseded
    expect(superseded.has('v1')).toBe(true)
    expect(superseded.has('v2')).toBe(false)
  })

  it('ignores non-system events', () => {
    const events = [
      evt('a', 'shell', { subtype: 'scope_violation', _causes: ['x'] }),
    ]
    const { superseded } = computeViolationStanding(events)
    expect(superseded.size).toBe(0)
  })
})
