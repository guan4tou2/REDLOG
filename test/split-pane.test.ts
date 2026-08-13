import { describe, it, expect } from 'vitest'
import { splitPaneClamp } from '../src/renderer/src/lib/splitPane'

// The <SplitPane> drag seam (DESIGN-SYSTEM §6.2). All bounds live here so the
// component's mousemove handler is a thin wrapper over a tested pure function.
describe('splitPaneClamp — resizable-pane bounds', () => {
  // In-range asks pass through untouched.
  it('returns px unchanged when within [min, max] and not starving the other pane', () => {
    expect(splitPaneClamp(300, 200, 500, 1000)).toBe(300)
  })

  it('clamps to max when px exceeds it', () => {
    expect(splitPaneClamp(600, 200, 500, 1000)).toBe(500)
  })

  it('clamps to min when px is below it', () => {
    expect(splitPaneClamp(100, 200, 500, 1000)).toBe(200)
  })

  // The other pane must keep `otherMin` px: a 1000px container with otherMin=120
  // caps the resizable pane at 880 even though its own max is 900.
  it('never starves the other pane below otherMin', () => {
    expect(splitPaneClamp(900, 200, 900, 1000, 120)).toBe(880)
  })

  // Degenerate: container too small to satisfy both — min wins, no inversion.
  it('falls back to min when the container cannot satisfy min + otherMin', () => {
    expect(splitPaneClamp(300, 200, 500, 250, 120)).toBe(200)
  })

  // Default otherMin (120) applies when omitted.
  it('applies the default otherMin of 120', () => {
    expect(splitPaneClamp(950, 200, 1000, 1000)).toBe(880)
  })

  // Exact-boundary asks are stable (idempotent at the edges).
  it('is stable at the min and max boundaries', () => {
    expect(splitPaneClamp(200, 200, 500, 1000)).toBe(200)
    expect(splitPaneClamp(500, 200, 500, 1000)).toBe(500)
  })
})
