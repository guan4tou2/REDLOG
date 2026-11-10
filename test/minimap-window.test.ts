// 069 / Stitch 05: the minimap's 重點視窗 gestures and its density drawing.
import { describe, expect, it } from 'vitest'
import { binRange, densityAreaPath, dragMinimapWindow, peakBin } from '../src/renderer/src/lib/minimapWindow'
import { computeBins, densestRun } from '../src/renderer/src/lib/timelineTimeMap'

describe('dragMinimapWindow', () => {
  const w = { left: 0.3, width: 0.2 }

  it('moving keeps the width and stops at either end', () => {
    expect(dragMinimapWindow(w, 'move', 0.1, 0.01)).toEqual({ left: 0.4, width: 0.2 })
    expect(dragMinimapWindow(w, 'move', -1, 0.01)).toEqual({ left: 0, width: 0.2 })
    const right = dragMinimapWindow(w, 'move', 1, 0.01)
    expect(right.left).toBeCloseTo(0.8)
    expect(right.width).toBe(0.2)
  })

  it('the start grip moves only the left edge', () => {
    const r = dragMinimapWindow(w, 'start', -0.1, 0.01)
    expect(r.left).toBeCloseTo(0.2)
    expect(r.left + r.width).toBeCloseTo(0.5)
    expect(dragMinimapWindow(w, 'start', -1, 0.01)).toEqual({ left: 0, width: 0.5 })
  })

  it('the end grip moves only the right edge', () => {
    const r = dragMinimapWindow(w, 'end', 0.1, 0.01)
    expect(r.left).toBe(0.3)
    expect(r.width).toBeCloseTo(0.3)
    const far = dragMinimapWindow(w, 'end', 5, 0.01)
    expect(far.left + far.width).toBeCloseTo(1)
  })

  it('a grip cannot pass the other edge or go under the zoom limit', () => {
    const s = dragMinimapWindow(w, 'start', 0.5, 0.05)
    expect(s.width).toBeCloseTo(0.05)
    expect(s.left + s.width).toBeCloseTo(0.5)
    const e = dragMinimapWindow(w, 'end', -0.5, 0.05)
    expect(e.left).toBe(0.3)
    expect(e.width).toBeCloseTo(0.05)
  })

  it('a full-width window stays put whatever the drag', () => {
    expect(dragMinimapWindow({ left: 0, width: 1 }, 'move', 0.3, 0.01)).toEqual({ left: 0, width: 1 })
  })
})

describe('densityAreaPath', () => {
  it('closes on the baseline and leaves empty bins at zero', () => {
    const d = densityAreaPath([0, 4, 0, 0], 4, 800, 28)
    expect(d.startsWith('M 0,28')).toBe(true)
    expect(d.endsWith('L 800,28 Z')).toBe(true)
    // bin 0 empty → on the baseline; bin 1 is the max → 90% up
    expect(d).toContain('L 100,28')
    expect(d).toContain('L 300,2.8')
  })

  it('a one-event bin is still visible', () => {
    const d = densityAreaPath([1, 0], 100, 800, 28)
    const y = Number(/L 200,([\d.]+)/.exec(d)![1])
    expect(y).toBeLessThan(28)
  })

  it('a range is squared off at its bin edges, so one bin still has width', () => {
    const d = densityAreaPath([0, 4, 0, 0], 4, 800, 28, [1, 1])
    expect(d.startsWith('M 200,28')).toBe(true)
    expect(d.endsWith('L 400,28 Z')).toBe(true)
  })

  it('draws nothing for no bins', () => {
    expect(densityAreaPath([], 1, 800, 28)).toBe('')
  })
})

describe('binRange / peakBin', () => {
  it('recovers the bins of the densest run', () => {
    const ts = [
      ...Array.from({ length: 12 }, (_, i) => 50_000 + i),
      ...Array.from({ length: 2 }, (_, i) => 10_000 + i * 1000)
    ]
    const bins = computeBins(ts, 0, 100_000, 100)
    const run = densestRun(bins, 0, 100_000)!
    expect(run).not.toBeNull()
    const range = binRange(run.start, run.end, 0, 100_000, bins.N)
    expect(range).toEqual([50, 50])
    expect(peakBin(bins.counts, range)).toBe(50)
  })

  it('takes the earlier bin on a tie', () => {
    expect(peakBin([0, 3, 5, 5, 1], [1, 4])).toBe(2)
  })
})
