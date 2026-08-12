import { describe, it, expect } from 'vitest'
import { wheelMode, type WheelContext } from '../src/renderer/src/lib/timelineWheel'

// Helper: build a WheelContext with sane defaults, override what a case cares about.
const ctx = (over: Partial<WheelContext> = {}): WheelContext => ({
  overflow: false,
  shiftKey: false,
  zoomKey: false,
  ...over
})

describe('wheelMode — the 4-row decision matrix (DESIGN-TIMELINE-INTERACTION T2)', () => {
  // Row 1: zoomKey=T, shift=—, overflow=— → 'zoom'
  it('zoomKey → zoom (overflow=false, shift=false)', () => {
    expect(wheelMode(ctx({ zoomKey: true, overflow: false, shiftKey: false }))).toBe('zoom')
  })

  // Row 2: zoomKey=F, shift=—, overflow=F → 'pan-x' (common case)
  it('no zoomKey, no overflow → pan-x (common case)', () => {
    expect(wheelMode(ctx({ zoomKey: false, overflow: false, shiftKey: false }))).toBe('pan-x')
  })

  // Row 3: zoomKey=F, shift=T, overflow=T → 'pan-x' (shift overrides scroll)
  it('no zoomKey, shift held, overflow → pan-x (shift overrides scroll-y)', () => {
    expect(wheelMode(ctx({ zoomKey: false, shiftKey: true, overflow: true }))).toBe('pan-x')
  })

  // Row 4: zoomKey=F, shift=F, overflow=T → 'scroll-y' (the surprising row)
  it('no zoomKey, no shift, overflow → scroll-y (the surprising row)', () => {
    expect(wheelMode(ctx({ zoomKey: false, shiftKey: false, overflow: true }))).toBe('scroll-y')
  })
})

describe('wheelMode — zoom precedence (zoom wins over shift & overflow)', () => {
  it('zoomKey beats shift', () => {
    expect(wheelMode(ctx({ zoomKey: true, shiftKey: true }))).toBe('zoom')
  })

  it('zoomKey beats overflow', () => {
    expect(wheelMode(ctx({ zoomKey: true, overflow: true }))).toBe('zoom')
  })

  it('zoomKey beats shift AND overflow together', () => {
    expect(wheelMode(ctx({ zoomKey: true, shiftKey: true, overflow: true }))).toBe('zoom')
  })
})

describe('wheelMode — shift only matters while overflow is true', () => {
  it('shift with no overflow is still the common pan-x path', () => {
    expect(wheelMode(ctx({ zoomKey: false, shiftKey: true, overflow: false }))).toBe('pan-x')
  })
})
