// Where the HUD goes by default (docs/UIUX-STANDARD.md §8).
//
// Pure, and in `core` rather than `main/windows.ts`, because it is a geometry
// decision with edge cases worth testing directly and `windows.ts` imports
// electron, which a unit test has no way to load.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Distance from the work-area edges, and the minimum gap kept at the right. */
const PAD = 8
/** Roughly the width a MacBook notch occupies, centred on the display. */
export const NOTCH_BAND_PT = 200

/**
 * Top of the screen, just right of the notch. Two constraints meeting: a
 * MacBook's notch owns the actual centre, and the menu-bar status area is
 * where the eye already goes for "what is my machine doing". Flush-right —
 * where the HUD used to sit — collides with the clock and every menu-bar app.
 *
 * The offset is derived from the notch rather than being a percentage of the
 * display width. A percentage looks equivalent and is not: 19% clears the band
 * on a 16" MacBook and lands inside it on a 13", because the notch is a fixed
 * size and the display is not.
 *
 * On a display too narrow to satisfy the constraint, staying on screen wins.
 */
export function defaultOverlayBounds(workArea: Rect, width: number): { x: number; y: number } {
  const clearOfNotch = workArea.x + Math.round(workArea.width / 2 + NOTCH_BAND_PT / 2)
  const maxX = workArea.x + workArea.width - width - PAD
  return {
    x: Math.max(workArea.x + PAD, Math.min(clearOfNotch, maxX)),
    y: workArea.y + PAD
  }
}

// --- HUD content sizing (docs/UIUX-STANDARD §8) ------------------------------
// The overlay is a fixed-width box the content flexes into (a long IP
// ellipsizes); its height is measured from the rendered content. The renderer
// requests a size and main clamps it — they MUST derive that size from the same
// numbers. They did not: the renderer sized width from the raw config scale
// while the panel rendered at a clamped scale, and its high-scale request
// (847pt) overshot the 720pt ceiling main enforces, so the granted window came
// back narrower than the content was laid out for and truncated the external IP
// — the one value the HUD exists to show. This module is that shared source.

/** Scale band: under 0.75 the 11px labels blur, over 1.75 the box outgrows any
 *  sane display. A non-finite or non-positive config value falls back to 1. */
export const HUD_SCALE_MIN = 0.75
export const HUD_SCALE_MAX = 1.75
export function clampHudScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.max(HUD_SCALE_MIN, Math.min(HUD_SCALE_MAX, scale))
}

/** Window-width band the `overlay:autosize` handler enforces in main. */
export const HUD_MIN_W = 380
export const HUD_MAX_W = 720
/** Height floor (also the window's created height before the first measure). */
export const HUD_MIN_H = 46
/** Chrome around the measured content: outer 3px padding ×2, the 1px frame
 *  inset, and the corner brackets' breathing room. Added before requesting. */
export const HUD_CONTENT_CHROME = 18

/**
 * Window width that fits the compact HUD bar at `scale`. 440pt at scale 1 is
 * the tuned base; padding and type scale with it so the box does too.
 * `emphasizeExternalIp` renders the external IP 1.4x, needing ~44pt more at
 * scale 1. The scale is clamped first (so it matches the panel, which renders
 * at the clamped scale) and the result to [380,720] (so the requested width and
 * the width main grants are always the same number).
 */
export function hudWindowWidth(scale: number, emphasizeExternalIp: boolean): number {
  const s = clampHudScale(scale)
  const raw = Math.round(440 * s) + (emphasizeExternalIp ? Math.round(44 * s) : 0)
  return Math.max(HUD_MIN_W, Math.min(HUD_MAX_W, raw))
}

/** Window height for a measured content block. Returns the floor for a
 *  non-positive measurement (jsdom, or before first layout). */
export function hudWindowHeight(measuredContentHeight: number): number {
  if (!(measuredContentHeight > 0)) return HUD_MIN_H
  return Math.max(HUD_MIN_H, Math.round(measuredContentHeight) + HUD_CONTENT_CHROME)
}
