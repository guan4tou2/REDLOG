import { describe, it, expect } from 'vitest'
import { buildTimeMap, computeDomainBounds, computeBins, densestRun, placeRulerMarkers, RULER_CHIP_W, tickLabelAlign, AXIS_LABEL_HALF_W } from '../src/renderer/src/lib/timelineTimeMap'

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

describe('densestRun', () => {
  const bins = (counts: number[]) => ({ counts, max: Math.max(1, ...counts), N: counts.length })
  const zeros = (n: number) => new Array(n).fill(0)

  it('is null with no data and with too few events', () => {
    expect(densestRun(computeBins([], 0, 1000, 10), 0, 1000)).toBeNull()
    const few = zeros(10); few[4] = 9
    expect(densestRun(bins(few), 0, 1000)).toBeNull()
  })

  it('is null for uniform data and for thin spread', () => {
    expect(densestRun(bins(new Array(10).fill(5)), 0, 1000)).toBeNull()
    expect(densestRun(bins([2, 2, 2, 2, 2, 2, 0, 0, 0, 0]), 0, 1000)).toBeNull()
  })

  it('names a single spike by its bin edges and count', () => {
    const c = zeros(10); c[3] = 20; c[7] = 1
    expect(densestRun(bins(c), 0, 1000)).toEqual({ start: 300, end: 400, count: 20 })
  })

  it('joins adjacent hot bins and ignores cooler neighbours', () => {
    const c = zeros(10); c[2] = 4; c[3] = 10; c[4] = 6; c[5] = 4
    // hot = 5: bins 3 and 4 only
    expect(densestRun(bins(c), 0, 1000)).toEqual({ start: 300, end: 500, count: 16 })
  })

  it('breaks a tie towards the earlier run', () => {
    const c = zeros(10); c[1] = 8; c[8] = 8
    expect(densestRun(bins(c), 0, 1000)).toEqual({ start: 100, end: 200, count: 8 })
  })

  it('property: the run lies inside the range and its count never exceeds the total', () => {
    let seed = 7
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    for (let k = 0; k < 200; k++) {
      const c = Array.from({ length: 24 }, () => Math.floor(rnd() * rnd() * 12))
      const r = densestRun(bins(c), 1000, 25000)
      if (!r) continue
      expect(r.start).toBeGreaterThanOrEqual(1000)
      expect(r.end).toBeLessThanOrEqual(25000)
      expect(r.start).toBeLessThan(r.end)
      expect(r.count).toBeLessThanOrEqual(c.reduce((a, b) => a + b, 0))
    }
  })
})

describe('placeRulerMarkers', () => {
  const W = RULER_CHIP_W
  it('shows no marker for a missing time', () => {
    expect(placeRulerMarkers({ focusX: null, latestX: null, trackW: 2000 })).toEqual({ focus: null, latest: null })
    const r = placeRulerMarkers({ focusX: null, latestX: 1000, trackW: 2000 })
    expect(r.focus).toBeNull()
    expect(r.latest).toEqual({ x: 1000, align: 'start', row: 0 })
  })

  it('flips a chip left of its tick when it would pass the track edge', () => {
    expect(placeRulerMarkers({ focusX: 2000 - W, latestX: null, trackW: 2000 }).focus?.align).toBe('start')
    expect(placeRulerMarkers({ focusX: 2000 - W + 1, latestX: null, trackW: 2000 }).focus?.align).toBe('end')
  })

  it('keeps both chips on row 0 when they do not overlap', () => {
    const r = placeRulerMarkers({ focusX: 100, latestX: 100 + W, trackW: 2000 })
    expect(r.focus?.row).toBe(0)
    expect(r.latest?.row).toBe(0)
  })

  it('drops [latest] to the second row on overlap and never moves [focus]', () => {
    const r = placeRulerMarkers({ focusX: 100, latestX: 100 + W - 1, trackW: 2000 })
    expect(r.focus).toEqual({ x: 100, align: 'start', row: 0 })
    expect(r.latest?.row).toBe(1)
    // The newest event selected: both on the same x, still two chips.
    const same = placeRulerMarkers({ focusX: 1990, latestX: 1990, trackW: 2000 })
    expect(same.focus?.row).toBe(0)
    expect(same.latest?.row).toBe(1)
  })

  it('treats a flipped [latest] against a start-aligned [focus] by their real spans', () => {
    // focus spans [1800,1950]; latest flips to [1850,2000]: overlap.
    expect(placeRulerMarkers({ focusX: 1800, latestX: 2000, trackW: 2000 }).latest?.row).toBe(1)
    // focus spans [1000,1150]; latest [1850,2000]: clear.
    expect(placeRulerMarkers({ focusX: 1000, latestX: 2000, trackW: 2000 }).latest?.row).toBe(0)
  })
})

describe('tickLabelAlign', () => {
  it('centres a label, and aligns one near either edge inward so it stays on the track', () => {
    expect(tickLabelAlign(500, 1000)).toBe('center')
    expect(tickLabelAlign(0, 1000)).toBe('start')
    expect(tickLabelAlign(AXIS_LABEL_HALF_W - 1, 1000)).toBe('start')
    expect(tickLabelAlign(1000, 1000)).toBe('end')
    expect(tickLabelAlign(1000 - AXIS_LABEL_HALF_W + 1, 1000)).toBe('end')
    expect(tickLabelAlign(AXIS_LABEL_HALF_W, 1000)).toBe('center')
  })
})
