// The density strip's one irreplaceable job is showing where nothing
// happened. Two things were stopping it.
//
// Linear normalisation does not survive this data. Capture is bursty by
// construction — a scan puts thousands of rows in one bin while the rest of
// the engagement puts tens in each of the others — so against `count / max`
// every bin that is not the burst collapses onto the floor together. The
// strip could not distinguish forty manual operations from one.

import { describe, it, expect } from 'vitest'
import { binHeight, computeBins } from '../src/renderer/src/lib/timelineTimeMap'

describe('the density strip', () => {
  it('draws nothing for an empty bin, whatever the scale', () => {
    // The gap is the point. A floor applied here would fill it in and the one
    // question this strip answers that the list cannot would be unanswerable.
    expect(binHeight(0, 5000)).toBe(0)
    expect(binHeight(0, 1)).toBe(0)
  })

  it('keeps ordinary activity legible beside a scan burst', () => {
    // The measured failure: 40 events next to a 5,000-event bin rendered at
    // 0.8% of the height — the same as a bin holding one.
    const linear = 40 / 5000
    const scaled = binHeight(40, 5000)
    expect(linear).toBeLessThan(0.01)
    expect(scaled).toBeGreaterThan(0.4)
  })

  it('still separates one event from forty', () => {
    // Compressing the ratio must not flatten the small end into a single step.
    const one = binHeight(1, 5000)
    const forty = binHeight(40, 5000)
    expect(forty - one).toBeGreaterThan(0.2)
  })

  it('never exceeds the full height, and the busiest bin reaches it', () => {
    expect(binHeight(5000, 5000)).toBeCloseTo(1, 6)
    expect(binHeight(9999, 5000)).toBeGreaterThan(1)
  })

  it('preserves ordering — a busier bin is never shorter', () => {
    const heights = [1, 2, 10, 100, 1000, 5000].map((c) => binHeight(c, 5000))
    expect(heights).toEqual([...heights].sort((a, b) => a - b))
  })

  it('handles a single-event engagement without dividing by zero', () => {
    expect(binHeight(1, 1)).toBeCloseTo(1, 6)
    expect(Number.isFinite(binHeight(1, 0))).toBe(true)
  })
})

describe('the bins themselves', () => {
  it('put an event at the end of the span in the last bin, not past it', () => {
    const bins = computeBins([0, 500, 1000], 0, 1000, 10)
    expect(bins.counts).toHaveLength(10)
    expect(bins.counts[9]).toBe(1)
    expect(bins.counts.reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('reports a max of at least one, so an empty range cannot divide by zero', () => {
    expect(computeBins([], 0, 1000, 10).max).toBe(1)
  })
})
