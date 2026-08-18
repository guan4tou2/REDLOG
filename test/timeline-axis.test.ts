import { describe, it, expect } from 'vitest'
import { lanesForAxis, laneOfEvent, buildLaneModel, UNTARGETED_LANE } from '../src/renderer/src/lib/timelineAxis'
import type { AxisEvent, AxisLane } from '../src/renderer/src/lib/timelineAxis'

// timelineAxis is the Phase C seam that lets the timeline's swim-lane rows come
// from either the current source-type lanes or a target grouping, WITHOUT the
// renderer caring which. 'source' delegates to the caller's existing lanes so
// the default is a byte-for-byte no-op; 'target' wraps the Phase B groupByTarget
// (untargeted last, §12). laneOfEvent must agree with lanesForAxis on lane ids.

const SOURCE_LANES: AxisLane[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'dns', label: 'DNS' }
]
const sourceLaneOf = (e: AxisEvent): string => (e as { agentType?: string }).agentType ?? 'system'

const ev = (id: string, timestamp: number, targetId?: string | null, agentType?: string): AxisEvent =>
  ({ id, timestamp, targetId, ...(agentType ? { agentType } : {}) } as AxisEvent)

describe('lanesForAxis — source axis (the zero-change default)', () => {
  it('returns the caller-supplied source lanes unchanged', () => {
    const lanes = lanesForAxis('source', [ev('a', 1, 'x')], SOURCE_LANES, 'Untargeted')
    expect(lanes).toEqual(SOURCE_LANES)
  })

  it('does not consult events for the source axis', () => {
    // Even with target data present, source axis ignores it.
    const lanes = lanesForAxis('source', [], SOURCE_LANES, 'Untargeted')
    expect(lanes).toEqual(SOURCE_LANES)
  })
})

describe('lanesForAxis — target axis', () => {
  it('builds one lane per target, ordered by first activity, untargeted last', () => {
    const events = [
      ev('a', 30, 'b.com'),
      ev('b', 10, 'a.com'),
      ev('c', 20, null),
      ev('d', 40, 'a.com')
    ]
    const lanes = lanesForAxis('target', events, SOURCE_LANES, 'Untargeted')
    // a.com first (ts 10), b.com next (ts 30), untargeted last regardless of ts
    expect(lanes.map((l) => l.id)).toEqual(['a.com', 'b.com', UNTARGETED_LANE])
    expect(lanes.map((l) => l.label)).toEqual(['a.com', 'b.com', 'Untargeted'])
  })

  it('uses the untargeted lane label for the null-target bucket only', () => {
    const lanes = lanesForAxis('target', [ev('a', 1, null)], SOURCE_LANES, 'No target')
    expect(lanes).toEqual([{ id: UNTARGETED_LANE, label: 'No target' }])
  })

  it('is empty for no events', () => {
    expect(lanesForAxis('target', [], SOURCE_LANES, 'Untargeted')).toEqual([])
  })
})

describe('laneOfEvent', () => {
  it('uses the source lane function on the source axis', () => {
    expect(laneOfEvent('source', ev('a', 1, 'x', 'scanner'), sourceLaneOf)).toBe('scanner')
  })

  it('maps a targeted event to its target id on the target axis', () => {
    expect(laneOfEvent('target', ev('a', 1, 'a.com'), sourceLaneOf)).toBe('a.com')
  })

  it('maps null / undefined / empty target to the untargeted lane', () => {
    expect(laneOfEvent('target', ev('a', 1, null), sourceLaneOf)).toBe(UNTARGETED_LANE)
    expect(laneOfEvent('target', ev('b', 1, undefined), sourceLaneOf)).toBe(UNTARGETED_LANE)
    expect(laneOfEvent('target', ev('c', 1, ''), sourceLaneOf)).toBe(UNTARGETED_LANE)
  })

  it('agrees with lanesForAxis: every event lands in a real lane (target axis)', () => {
    const events = [ev('a', 1, 'a.com'), ev('b', 2, null), ev('c', 3, 'b.com')]
    const laneIds = new Set(lanesForAxis('target', events, SOURCE_LANES, 'U').map((l) => l.id))
    for (const e of events) expect(laneIds.has(laneOfEvent('target', e, sourceLaneOf))).toBe(true)
  })
})

describe('buildLaneModel', () => {
  it('source: lanes are the source lanes, grouped by sourceLaneOf, every lane seeded', () => {
    const events = [ev('a', 1, null, 'shell'), ev('b', 2, null, 'dns'), ev('c', 3, null, 'shell')]
    const m = buildLaneModel('source', events, SOURCE_LANES, sourceLaneOf, 'Untargeted')
    expect(m.lanes).toEqual(SOURCE_LANES)
    expect(m.laneEvents['shell'].map((e) => e.id)).toEqual(['a', 'c'])
    expect(m.laneEvents['dns'].map((e) => e.id)).toEqual(['b'])
    expect(m.laneOf(events[0])).toBe('shell')
  })

  it('target: lanes from grouping, events bucketed by target, untargeted seeded', () => {
    const events = [ev('a', 10, 'x.com'), ev('b', 20, null), ev('c', 30, 'x.com')]
    const m = buildLaneModel('target', events, SOURCE_LANES, sourceLaneOf, 'Untargeted')
    expect(m.lanes.map((l) => l.id)).toEqual(['x.com', UNTARGETED_LANE])
    expect(m.laneEvents['x.com'].map((e) => e.id)).toEqual(['a', 'c'])
    expect(m.laneEvents[UNTARGETED_LANE].map((e) => e.id)).toEqual(['b'])
  })

  it('every lane in `lanes` has an entry even when empty (source seeding)', () => {
    const m = buildLaneModel('source', [ev('a', 1, null, 'shell')], SOURCE_LANES, sourceLaneOf, 'U')
    expect(m.laneEvents['dns']).toEqual([]) // seeded empty, safe to index
  })
})
