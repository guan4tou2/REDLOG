import { describe, it, expect } from 'vitest'
import { buildTimeMap, computeDomainBounds, computeBins } from '../src/renderer/src/lib/timelineTimeMap'

const GAP_MIN_MS = 10 * 60_000
const GAP_PX = 48

describe('buildTimeMap', () => {
  const base = {
    gapMinMs: GAP_MIN_MS,
    gapPx: GAP_PX,
    compressGaps: false,
  }

  it('returns linear map when no events', () => {
    const m = buildTimeMap({ ...base, displayTimestamps: [], timeStart: 0, timeEnd: 1000, timeSpan: 1000, trackW: 500 })
    expect(m.gaps).toEqual([])
    expect(m.toX(500)).toBeCloseTo(250)
    expect(m.fromX(250)).toBeCloseTo(500)
  })

  it('returns linear map when timeSpan is 0', () => {
    const m = buildTimeMap({ ...base, displayTimestamps: [100], timeStart: 100, timeEnd: 100, timeSpan: 0, trackW: 500 })
    expect(m.gaps).toEqual([])
  })

  it('linear round-trip', () => {
    const ts = [1000, 2000, 3000]
    const m = buildTimeMap({ ...base, displayTimestamps: ts, timeStart: 0, timeEnd: 4000, timeSpan: 4000, trackW: 800 })
    expect(m.gaps).toEqual([])
    for (const t of ts) {
      expect(m.fromX(m.toX(t))).toBeCloseTo(t, 1)
    }
  })

  it('detects gaps without compressing', () => {
    // Two clusters separated by >GAP_MIN_MS: events at 1000 and then at 700000.
    // cursor stays at timeStart=0; gap is detected from 0 to 700000.
    const ts = [1000, 2000, 2000 + GAP_MIN_MS + 1000]
    const m = buildTimeMap({
      ...base,
      displayTimestamps: ts,
      timeStart: 0,
      timeEnd: ts[2] + 1000,
      timeSpan: ts[2] + 1000,
      trackW: 1000,
      compressGaps: false
    })
    expect(m.gaps.length).toBe(1)
  })

  it('compresses gaps when enabled — live segments fill more track', () => {
    // Place a dense cluster at the START so cursor stays near timeStart,
    // then a long empty stretch, then another cluster.
    const cluster1End = 5000
    const cluster2Start = cluster1End + GAP_MIN_MS + 60_000
    const cluster2End = cluster2Start + 5000
    const ts = [100, 500, 1000, 3000, cluster1End, cluster2Start, cluster2Start + 1000, cluster2End]
    const tEnd = cluster2End + 1000
    const m = buildTimeMap({
      ...base,
      displayTimestamps: ts,
      timeStart: 0,
      timeEnd: tEnd,
      timeSpan: tEnd,
      trackW: 2000,
      compressGaps: true
    })
    expect(m.gaps.length).toBeGreaterThan(0)
    // With compression, events AFTER the gap should be closer together in
    // pixels than they would be linearly.
    const linearM = buildTimeMap({
      ...base,
      displayTimestamps: ts,
      timeStart: 0,
      timeEnd: tEnd,
      timeSpan: tEnd,
      trackW: 2000,
      compressGaps: false
    })
    const xLinear = linearM.toX(cluster2Start) - linearM.toX(cluster2End)
    const xCompressed = m.toX(cluster2Start) - m.toX(cluster2End)
    // Compressed live segments are stretched, so the pixel distance for
    // the same time distance should be LARGER than linear.
    expect(Math.abs(xCompressed)).toBeGreaterThan(Math.abs(xLinear))
  })

  it('compressed fromX round-trips through live segments', () => {
    // Create two live clusters with a gap in between.
    // Test round-trip ONLY for timestamps in the second (post-gap) live segment.
    const cluster2Start = GAP_MIN_MS + 60_000
    const cluster2End = cluster2Start + 10_000
    const ts = [100, cluster2Start, cluster2End]
    const m = buildTimeMap({
      ...base,
      displayTimestamps: ts,
      timeStart: 0,
      timeEnd: cluster2End + 5000,
      timeSpan: cluster2End + 5000,
      trackW: 2000,
      compressGaps: true
    })
    // Round-trip for a timestamp well inside the post-gap live segment.
    const probe = cluster2Start + 5000
    expect(m.fromX(m.toX(probe))).toBeCloseTo(probe, 0)
  })

  it('no gaps when events are dense', () => {
    const ts = Array.from({ length: 100 }, (_, i) => i * 1000)
    const m = buildTimeMap({
      ...base,
      displayTimestamps: ts,
      timeStart: 0,
      timeEnd: 100_000,
      timeSpan: 100_000,
      trackW: 2000
    })
    expect(m.gaps).toEqual([])
  })
})

describe('computeDomainBounds', () => {
  it('returns hour-wide window for empty events', () => {
    const b = computeDomainBounds([])
    expect(b.timeEnd - b.timeStart).toBe(3600000)
    expect(b.ticks).toEqual([])
  })

  it('pads domain around events', () => {
    const events = [
      { timestamp: 10000, agentType: 'shell' },
      { timestamp: 20000, agentType: 'shell' }
    ]
    const b = computeDomainBounds(events)
    expect(b.timeStart).toBeLessThan(10000)
    expect(b.timeEnd).toBeGreaterThan(20000)
    expect(b.ticks.length).toBeGreaterThanOrEqual(5)
  })

  it('widens domain for marker atTimestamp', () => {
    const events = [
      { timestamp: 10000, agentType: 'shell' },
      { timestamp: 20000, agentType: 'marker', data: { atTimestamp: 5000 } },
      { timestamp: 30000, agentType: 'shell' }
    ]
    const b = computeDomainBounds(events)
    expect(b.timeStart).toBeLessThan(5000)
  })

  it('ignores non-marker atTimestamp', () => {
    const events = [
      { timestamp: 10000, agentType: 'shell', data: { atTimestamp: 1 } },
      { timestamp: 20000, agentType: 'shell' }
    ]
    const b = computeDomainBounds(events)
    // Domain should be based on timestamps [10000, 20000], not atTimestamp=1
    // pad = max((20000-10000)*0.05, 60000) = 60000
    expect(b.timeStart).toBeCloseTo(10000 - 60000, -2)
  })
})

describe('computeBins', () => {
  it('returns all zeros for empty input', () => {
    const b = computeBins([], 0, 1000, 10)
    expect(b.counts).toEqual(new Array(10).fill(0))
    expect(b.max).toBe(1)
  })

  it('bins events into correct cells', () => {
    const b = computeBins([100, 150, 900], 0, 1000, 10)
    expect(b.counts[1]).toBe(2)
    expect(b.counts[9]).toBe(1)
    expect(b.max).toBe(2)
  })

  it('clamps timestamps at domain edges', () => {
    const b = computeBins([-50, 1050], 0, 1000, 10)
    expect(b.counts[0]).toBe(1)
    expect(b.counts[9]).toBe(1)
  })
})
