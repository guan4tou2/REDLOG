// The window that is running, in the task bar, and drawing nothing.
//
// RedLog restored its saved bounds verbatim, so a position saved on a monitor
// that is no longer there — unplugged, rearranged, or replaced by a different
// desktop geometry on an RDP reconnect — opened the window off the screen. The
// operator sees an app that did not start, restarts it, and gets the same
// invisible rectangle.
import { describe, it, expect } from 'vitest'
import { visibleWindowBounds, type Rect } from '../src/main/window-bounds'

// The arrangement this was diagnosed on: two displays side by side, no stacked
// one any more, work areas slightly shorter than the displays (task bar).
const LEFT: Rect = { x: 0, y: 0, width: 1800, height: 1077 }
const RIGHT: Rect = { x: 1800, y: 0, width: 1920, height: 1032 }
const DESKTOP = [LEFT, RIGHT]

describe('visibleWindowBounds', () => {
  it('leaves a window that is on a display exactly where it was', () => {
    const saved = { x: 288, y: 120, width: 1067, height: 656 }
    expect(visibleWindowBounds(saved, DESKTOP)).toEqual(saved)
  })

  it('leaves a deliberately half-off-screen window alone', () => {
    // The operator parked it against the edge. A title bar's worth is still
    // reachable, so this is an arrangement, not a fault.
    const saved = { x: -900, y: 40, width: 1067, height: 656 }
    expect(visibleWindowBounds(saved, DESKTOP)).toEqual(saved)
  })

  it('brings back the window saved on a monitor that is gone', () => {
    // The real one: y=1191 on a 3720x1125 desktop — entirely below the bottom
    // edge, on a stacked display that no longer exists.
    const saved = { x: 288, y: 1191, width: 1067, height: 656 }
    const out = visibleWindowBounds(saved, DESKTOP)!
    expect(out).not.toEqual(saved)
    // Back on the display it slipped off, not teleported to the other one.
    expect(out.x).toBeGreaterThanOrEqual(LEFT.x)
    expect(out.x + out.width).toBeLessThanOrEqual(LEFT.x + LEFT.width)
    expect(out.y + out.height).toBeLessThanOrEqual(LEFT.y + LEFT.height)
    // Its size is the operator's choice and survives.
    expect(out.width).toBe(saved.width)
    expect(out.height).toBe(saved.height)
  })

  it('shrinks a window too big for the display it lands on', () => {
    const saved = { x: 4000, y: 4000, width: 3000, height: 2000 }
    const out = visibleWindowBounds(saved, [LEFT])!
    expect(out).toEqual({ x: 0, y: 0, width: LEFT.width, height: LEFT.height })
  })

  it('falls back to the primary display when it overlaps nothing', () => {
    // Electron lists the primary display first.
    const saved = { x: 9000, y: 9000, width: 800, height: 600 }
    const out = visibleWindowBounds(saved, DESKTOP)!
    expect(out.x + out.width).toBeLessThanOrEqual(LEFT.x + LEFT.width)
    expect(out.y + out.height).toBeLessThanOrEqual(LEFT.y + LEFT.height)
  })

  it('never invents bounds it was not given', () => {
    // No saved state means Electron's own default placement, not a guess.
    expect(visibleWindowBounds(undefined, DESKTOP)).toBeUndefined()
    // And a display list that has not arrived yet must not move anything.
    const saved = { x: 288, y: 1191, width: 1067, height: 656 }
    expect(visibleWindowBounds(saved, [])).toEqual(saved)
  })
})
