import { describe, it, expect } from 'vitest'
import { clusterEvents } from '../src/renderer/src/lib/timelineCluster'
import type { ClusterInput } from '../src/renderer/src/lib/timelineCluster'

// Pins the behaviour of Timeline.tsx's inline `clusters` memo (the 14px same-lane
// bucketing) before the axis refactor (SPEC-TIMELINE-AXIS Step 1). These are
// characterisation tests: any drift here is a change to what the operator sees on
// the track, so they mirror the inline grid-bucketing semantics exactly —
// consecutive same-bin merge, mean-x representative, first-id key, input order.

const ev = (id: string, lane: string, x: number): ClusterInput => ({ id, lane, x })

describe('clusterEvents', () => {
  it('returns [] for empty input', () => {
    expect(clusterEvents([])).toEqual([])
  })

  it('makes a single-element cluster for one event', () => {
    expect(clusterEvents([ev('a', 'shell', 5)])).toEqual([
      { key: 'shell-a', lane: 'shell', x: 5, ids: ['a'], count: 1 }
    ])
  })

  it('merges same-lane events inside one 14px bin into one counted cluster', () => {
    // x=2 and x=10 → bin 0 for both (Math.floor(x/14) === 0).
    const out = clusterEvents([ev('a', 'shell', 2), ev('b', 'shell', 10)])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      key: 'shell-a',
      lane: 'shell',
      x: 6, // mean of 2 and 10
      ids: ['a', 'b'],
      count: 2
    })
  })

  it('does not merge events on different lanes even at the same x', () => {
    const out = clusterEvents([ev('a', 'shell', 3), ev('b', 'http', 3)])
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.lane)).toEqual(['shell', 'http'])
    expect(out.every((c) => c.count === 1)).toBe(true)
  })

  it('splits events into separate clusters once they cross a bin boundary', () => {
    // x=13 → bin 0, x=15 → bin 1: only 2px apart but on opposite sides of the
    // 14px grid line, so the inline code keeps them separate. Mirrored here.
    const out = clusterEvents([ev('a', 'shell', 13), ev('b', 'shell', 15)])
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.ids)).toEqual([['a'], ['b']])
  })

  it('treats an exact multiple of mergePx as the start of the next bin', () => {
    // x=13 → bin 0, x=14 → bin 1 (14/14 === 1). Boundary is exclusive-below.
    const out = clusterEvents([ev('a', 'shell', 13), ev('b', 'shell', 14)])
    expect(out).toHaveLength(2)
  })

  it('counts a dense burst and averages the member xs', () => {
    // Four events all inside bin 0 (0..13).
    const out = clusterEvents([
      ev('a', 'shell', 0),
      ev('b', 'shell', 4),
      ev('c', 'shell', 8),
      ev('d', 'shell', 12)
    ])
    expect(out).toHaveLength(1)
    expect(out[0].count).toBe(4)
    expect(out[0].ids).toEqual(['a', 'b', 'c', 'd'])
    expect(out[0].x).toBe(6) // (0+4+8+12)/4
    expect(out[0].key).toBe('shell-a') // key uses the first member id
  })

  it('emits clusters per lane in first-seen lane order, events in input order', () => {
    // Two lanes interleaved in the input; grouping is stable by first appearance.
    const out = clusterEvents([
      ev('a', 'http', 2),
      ev('b', 'shell', 2),
      ev('c', 'http', 6),
      ev('d', 'shell', 40)
    ])
    // http seen first → its clusters come first. a+c share bin 0 → one cluster.
    // shell: b in bin 0, d in bin 2 → two clusters.
    expect(out.map((c) => c.lane)).toEqual(['http', 'shell', 'shell'])
    expect(out[0]).toMatchObject({ lane: 'http', ids: ['a', 'c'], count: 2 })
    expect(out[1]).toMatchObject({ lane: 'shell', ids: ['b'], count: 1 })
    expect(out[2]).toMatchObject({ lane: 'shell', ids: ['d'], count: 1 })
  })

  it('honours a custom mergePx threshold', () => {
    // With mergePx=100, x=2 and x=90 fall in the same bin 0 and merge, whereas
    // the default 14 would split them (bins 0 and 6).
    expect(clusterEvents([ev('a', 'shell', 2), ev('b', 'shell', 90)], 100)).toHaveLength(1)
    expect(clusterEvents([ev('a', 'shell', 2), ev('b', 'shell', 90)])).toHaveLength(2)
  })
})
