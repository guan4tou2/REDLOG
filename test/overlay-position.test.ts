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

import {
  clampHudScale, hudWindowWidth, hudWindowHeight,
  HUD_SCALE_MIN, HUD_SCALE_MAX, HUD_MIN_W, HUD_MAX_W, HUD_MIN_H, HUD_CONTENT_CHROME
} from '../src/core/overlay-layout'

// §8 HUD sizing. The overlay is a fixed-width box the content flexes into and a
// measured-height box. The renderer requests a size and main clamps it; these
// assertions pin the invariant that broke once — the two must derive the size
// from the same numbers, or the granted window is narrower than the content was
// laid out for and the external IP (the whole point of the HUD) truncates.

describe('HUD window sizing', () => {
  it('clamps scale to the legible band, healing junk config', () => {
    expect(clampHudScale(1)).toBe(1)
    expect(clampHudScale(0.1)).toBe(HUD_SCALE_MIN)
    expect(clampHudScale(9)).toBe(HUD_SCALE_MAX)
    // a non-finite / non-positive config value falls back to 1, never NaN
    expect(clampHudScale(NaN)).toBe(1)
    expect(clampHudScale(0)).toBe(1)
    expect(clampHudScale(-2)).toBe(1)
  })

  it('width stays inside the band main enforces, at every scale', () => {
    for (const scale of [0.1, 0.75, 1, 1.25, 1.5, 1.75, 3]) {
      for (const emph of [false, true]) {
        const w = hudWindowWidth(scale, emph)
        expect(w, `scale ${scale} emph ${emph}`).toBeGreaterThanOrEqual(HUD_MIN_W)
        expect(w, `scale ${scale} emph ${emph}`).toBeLessThanOrEqual(HUD_MAX_W)
      }
    }
  })

  it('the request main grants back equals what the renderer asked for', () => {
    // main re-clamps whatever it receives; because hudWindowWidth already sits
    // in-band, that clamp is a no-op — request and grant are the same number.
    const mainClamp = (w: number): number => Math.max(HUD_MIN_W, Math.min(HUD_MAX_W, Math.round(w)))
    for (const scale of [0.75, 1, 1.4, 1.75]) {
      const asked = hudWindowWidth(scale, true)
      expect(mainClamp(asked)).toBe(asked)
    }
  })

  it('the historical overshoot is gone: scale 1.75 no longer requests 847pt', () => {
    // Old formula: round(440*1.75) + round(44*1.75) = 770 + 77 = 847, which
    // main capped to 720 — so the window came back 127pt short of the layout.
    expect(770 + 77).toBeGreaterThan(HUD_MAX_W) // the overshoot that used to escape
    expect(hudWindowWidth(1.75, true)).toBe(HUD_MAX_W) // now capped at the source
  })

  it('emphasizeExternalIp widens the box (until the cap swallows both)', () => {
    expect(hudWindowWidth(1, true)).toBeGreaterThan(hudWindowWidth(1, false))
  })

  it('height is measured content plus chrome, floored for jsdom/zero', () => {
    expect(hudWindowHeight(0)).toBe(HUD_MIN_H)       // jsdom offsetHeight === 0
    expect(hudWindowHeight(-5)).toBe(HUD_MIN_H)
    expect(hudWindowHeight(120)).toBe(120 + HUD_CONTENT_CHROME)
    expect(hudWindowHeight(1)).toBe(HUD_MIN_H)       // tiny content still clears the floor
  })
})
