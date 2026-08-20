import { describe, it, expect } from 'vitest'
import { defaultOverlayBounds, NOTCH_BAND_PT, type Rect } from '../src/core/overlay-layout'

// §8: top of the screen, centred but pushed right. Two constraints meeting —
// a MacBook's notch owns the actual centre, and flush-right (where the HUD
// used to sit) collides with the clock and every menu-bar app. The interesting
// cases are the displays where those two pulls cannot both be satisfied.

const area = (width: number, x = 0, y = 0): Rect => ({ x, y, width, height: 900 })

describe('default HUD placement', () => {
  it('sits right of centre on a normal display', () => {
    const { x } = defaultOverlayBounds(area(1728), 440)
    const centred = (1728 - 440) / 2
    expect(x).toBeGreaterThan(centred)
  })

  it('starts clear of the notch band, not merely right of centre', () => {
    // The distinction matters: a window whose *centre* is right of the display
    // centre can still begin inside the notch band and sit under it. What has
    // to clear is the left edge.
    for (const width of [1728, 1512, 1920, 2560]) {
      const { x } = defaultOverlayBounds(area(width), 440)
      expect(x, `${width}pt display`).toBeGreaterThanOrEqual(width / 2 + NOTCH_BAND_PT / 2)
    }
  })

  it('stays on screen on a display too narrow for the shift', () => {
    // 12% of a 1024pt display is more room than remains after a 440pt window.
    const { x } = defaultOverlayBounds(area(1024), 440)
    expect(x + 440).toBeLessThanOrEqual(1024 - 8 + 1)
    expect(x).toBeGreaterThanOrEqual(8)
  })

  it('respects a work area that does not start at zero', () => {
    // A second display to the right of the primary, or a taskbar-shifted
    // origin — placement is relative, not absolute.
    const { x, y } = defaultOverlayBounds(area(1440, 1728, 100), 440)
    expect(x).toBeGreaterThanOrEqual(1728)
    expect(x + 440).toBeLessThanOrEqual(1728 + 1440)
    expect(y).toBe(108)
  })

  it('never returns a negative or off-origin position on a tiny display', () => {
    const { x } = defaultOverlayBounds(area(500), 440)
    expect(x).toBeGreaterThanOrEqual(8)
  })
})
