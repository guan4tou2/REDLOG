import { describe, it, expect } from 'vitest'
import { bucketByPixel, tightestLaneGap, computeMaxZoom, buildClusters, filterVisibleClusters } from '../src/renderer/src/lib/timelineGeometry'
import type { RedLogEvent } from '../src/core/db/event-types'

function evt(
  id: string,
  agentType: string,
  data: Record<string, unknown> = {},
  extra: Partial<RedLogEvent> = {}
): RedLogEvent {
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
    ...extra
  }
}

describe('bucketByPixel', () => {
  const xOf = (n: number): number => n // identity: the number IS the pixel

  it('groups consecutive items sharing a clusterPx column', () => {
    // clusterPx 10 → columns [0,10), [10,20), ...
    const items = [0, 3, 9, 12, 15, 40]
    const buckets = bucketByPixel(items, xOf, 10)
    expect(buckets).toEqual([[0, 3, 9], [12, 15], [40]])
  })

  it('starts a new bucket only when the column index changes, in draw order', () => {
    // 19 and 20 straddle the 10-wide column boundary (floor 1 vs 2).
    expect(bucketByPixel([19, 20], xOf, 10)).toEqual([[19], [20]])
    expect(bucketByPixel([10, 19], xOf, 10)).toEqual([[10, 19]])
  })

  it('is empty for no items and single-bucket for one', () => {
    expect(bucketByPixel([], xOf, 10)).toEqual([])
    expect(bucketByPixel([5], xOf, 10)).toEqual([[5]])
  })
})

describe('tightestLaneGap', () => {
  it('is the smallest positive consecutive gap across all lanes', () => {
    expect(tightestLaneGap([[0, 100, 130], [0, 5, 500]])).toBe(5)
  })
  it('ignores zero and negative gaps (coincident / unordered)', () => {
    expect(tightestLaneGap([[10, 10, 10]])).toBe(Infinity)
  })
  it('is Infinity when no lane has two events', () => {
    expect(tightestLaneGap([[1], [], [42]])).toBe(Infinity)
  })
  it('short-circuits once a gap at or below the ceiling is found', () => {
    // The 2-gap is <= ceilingGap 3, so it returns without needing to find the
    // 1-gap in a later lane — the same early-out the inline code made.
    expect(tightestLaneGap([[0, 2], [0, 1]], 3)).toBe(2)
  })
})

describe('computeMaxZoom', () => {
  const base = { clusterPx: 14, maxTrackW: 400_000, minBaseTrackW: 2000 }

  it('floors at 6 for a sparse or empty timeline', () => {
    expect(computeMaxZoom({ ...base, laneTimestamps: [[1]], timeSpan: 60_000 })).toBe(6)
    expect(computeMaxZoom({ ...base, laneTimestamps: [[1, 2]], timeSpan: 0 })).toBe(6)
  })

  it('raises the ceiling so the tightest gap can open to clusterPx', () => {
    // Two events 100ms apart inside a 10-minute span: zoom must widen the track
    // enough that 100ms maps to >= 14px, i.e. neededTrackW / minBaseTrackW.
    const span = 600_000
    const z = computeMaxZoom({ ...base, laneTimestamps: [[0, 100]], timeSpan: span })
    const expected = Math.max(6, Math.min(base.maxTrackW / base.minBaseTrackW, ((span / 100) * base.clusterPx) / base.minBaseTrackW))
    expect(z).toBeCloseTo(expected, 6)
    expect(z).toBeGreaterThan(6)
  })

  it('never exceeds the maxTrackW-derived ceiling even for a sub-ms burst', () => {
    const z = computeMaxZoom({ ...base, laneTimestamps: [[0, 1]], timeSpan: 3_600_000 })
    expect(z).toBeLessThanOrEqual(base.maxTrackW / base.minBaseTrackW)
  })
})

// ── buildClusters ──────────────────────────────────────────────────

describe('buildClusters', () => {
  const LANE_H = 40
  const CLUSTER_PX = 10
  const toX = (ts: number): number => ts // 1 ms = 1 px

  it('produces one cluster per pixel-bucket per row', () => {
    const e1 = evt('a', 'shell', {}, { timestamp: 0 })
    const e2 = evt('b', 'shell', {}, { timestamp: 5 })
    const e3 = evt('c', 'shell', {}, { timestamp: 20 })
    const clusters = buildClusters(['shell'], { shell: [e1, e2, e3] }, toX, LANE_H, CLUSTER_PX, undefined)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].events).toEqual([e1, e2])
    expect(clusters[1].events).toEqual([e3])
  })

  it('assigns correct y from row index and laneH', () => {
    const e1 = evt('a', 'shell', {}, { timestamp: 100 })
    const e2 = evt('b', 'http_navigation', {}, { timestamp: 200 })
    const rows = ['shell', 'http_navigation']
    const clusters = buildClusters(
      rows,
      { shell: [e1], http_navigation: [e2] },
      toX, LANE_H, CLUSTER_PX, undefined
    )
    expect(clusters[0].y).toBe(0 * LANE_H + LANE_H / 2) // row 0
    expect(clusters[1].y).toBe(1 * LANE_H + LANE_H / 2) // row 1
  })

  it('x is the average pixel position of bucket events', () => {
    const e1 = evt('a', 'shell', {}, { timestamp: 2 })
    const e2 = evt('b', 'shell', {}, { timestamp: 6 })
    const clusters = buildClusters(['shell'], { shell: [e1, e2] }, toX, LANE_H, CLUSTER_PX, undefined)
    expect(clusters[0].x).toBe(4) // (2 + 6) / 2
  })

  it('skips rows with no events', () => {
    const e1 = evt('a', 'shell', {}, { timestamp: 0 })
    const clusters = buildClusters(
      ['shell', 'dns', 'http_navigation'],
      { shell: [e1] },
      toX, LANE_H, CLUSTER_PX, undefined
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0].lane).toBe('shell')
  })

  it('resolves lane via toLane for colour (not row key)', () => {
    const e1 = evt('a', 'system', { subtype: 'scope_violation' }, { timestamp: 50 })
    const clusters = buildClusters(['system'], { system: [e1] }, toX, LANE_H, CLUSTER_PX, undefined)
    expect(clusters[0].lane).toBe('scope')
  })

  it('returns empty for empty rows', () => {
    expect(buildClusters([], {}, toX, LANE_H, CLUSTER_PX, undefined)).toEqual([])
  })

  it('key is rowKey-firstEventId', () => {
    const e1 = evt('ev42', 'shell', {}, { timestamp: 0 })
    const clusters = buildClusters(['shell'], { shell: [e1] }, toX, LANE_H, CLUSTER_PX, undefined)
    expect(clusters[0].key).toBe('shell-ev42')
  })
})

// ── filterVisibleClusters ──────────────────────────────────────────

describe('filterVisibleClusters', () => {
  function cluster(x: number): { key: string; lane: 'shell'; li: number; x: number; y: number; events: RedLogEvent[] } {
    return { key: `k-${x}`, lane: 'shell', li: 0, x, y: 20, events: [] }
  }

  it('returns all when trackW <= 0', () => {
    const cs = [cluster(50), cluster(150)]
    expect(filterVisibleClusters(cs, 0, 10, 50)).toBe(cs)
    expect(filterVisibleClusters(cs, -1, 10, 50)).toBe(cs)
  })

  it('returns all when viewWidth <= 0', () => {
    const cs = [cluster(50)]
    expect(filterVisibleClusters(cs, 1000, 10, 0)).toBe(cs)
  })

  it('returns all when the viewport covers the entire track', () => {
    const cs = [cluster(0), cluster(500), cluster(999)]
    expect(filterVisibleClusters(cs, 1000, 0, 100)).toBe(cs)
  })

  it('filters to a one-width buffer around the viewport', () => {
    // trackW=1000, viewLeft=50% (500px), viewWidth=10% (100px)
    // from = 500 - 100 = 400, to = 500 + 200 = 700
    const cs = [cluster(100), cluster(450), cluster(600), cluster(800)]
    const visible = filterVisibleClusters(cs, 1000, 50, 10)
    expect(visible.map((c) => c.x)).toEqual([450, 600])
  })

  it('includes clusters at exact boundary values', () => {
    // from = 400, to = 700 (same as above)
    const cs = [cluster(400), cluster(700)]
    const visible = filterVisibleClusters(cs, 1000, 50, 10)
    expect(visible.map((c) => c.x)).toEqual([400, 700])
  })
})
