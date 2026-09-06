import { describe, it, expect } from 'vitest'
import { bucketByPixel, tightestLaneGap, computeMaxZoom } from '../src/renderer/src/lib/timelineGeometry'

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
