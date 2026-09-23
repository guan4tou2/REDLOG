import { describe, it, expect } from 'vitest'
import { buildEffectsIndex, computeViolationStanding, buildFoldIndex, buildBadgeIndex } from '../src/renderer/src/lib/timelineAnnotations'
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

  // The Timeline passes its rows oldest-first. The record that stands is the one
  // written last, as in readExistingViolations, whatever order the caller uses.
  it('keeps the violation written last, in either input order', () => {
    const older = { ...evt('v1', 'system', { subtype: 'scope_violation', _causes: ['src1'] }), createdAt: 1000 }
    const newer = { ...evt('v2', 'system', { subtype: 'scope_violation', _causes: ['src1'] }), createdAt: 2000 }
    for (const events of [[older, newer], [newer, older]]) {
      const { superseded } = computeViolationStanding(events)
      expect(superseded.has('v1')).toBe(true)
      expect(superseded.has('v2')).toBe(false)
    }
  })

  it('does not let an in_scope verdict supersede a violation', () => {
    const violation = { ...evt('v1', 'system', { subtype: 'scope_violation', distance: 'unrelated', _causes: ['src1'] }), createdAt: 1000 }
    const inScope = { ...evt('r2', 'system', { subtype: 'scope_violation', distance: 'in_scope', _causes: ['src1'] }), createdAt: 2000 }
    for (const events of [[violation, inScope], [inScope, violation]]) {
      expect(computeViolationStanding(events).superseded.has('v1')).toBe(false)
    }
  })

  it('ignores non-system events', () => {
    const events = [
      evt('a', 'shell', { subtype: 'scope_violation', _causes: ['x'] }),
    ]
    const { superseded } = computeViolationStanding(events)
    expect(superseded.size).toBe(0)
  })
})

describe('buildFoldIndex', () => {
  it('returns empty map when no markers', () => {
    const events = [evt('a', 'shell')]
    expect(buildFoldIndex(events).size).toBe(0)
  })

  it('returns empty map when no amendments', () => {
    const events = [evt('m1', 'marker', { title: 'SQLi', severity: 'high' })]
    expect(buildFoldIndex(events).size).toBe(0)
  })

  it('folds amendments into original marker', () => {
    const events = [
      evt('m1', 'marker', { title: 'SQLi', severity: 'high' }),
      evt('a1', 'marker', { subtype: 'amended', markerId: 'm1', title: 'SQLi confirmed', severity: 'critical' })
    ]
    const folds = buildFoldIndex(events)
    expect(folds.size).toBe(1)
    const fold = folds.get('m1')!
    expect(fold.effective.title).toBe('SQLi confirmed')
    expect(fold.effective.severity).toBe('critical')
    expect(fold.amendCount).toBe(1)
  })
})

describe('buildBadgeIndex', () => {
  it('returns empty map for normal events', () => {
    const events = [evt('a', 'shell')]
    expect(buildBadgeIndex(events, null, new Set(), new Set()).size).toBe(0)
  })

  it('badges the event at broken chain point', () => {
    const events = [evt('a', 'shell')]
    const badges = buildBadgeIndex(events, 'a', new Set(), new Set())
    expect(badges.has('a')).toBe(true)
    expect(badges.get('a')!.length).toBeGreaterThan(0)
  })
})
