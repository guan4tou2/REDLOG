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

/** Base window width at scale 1, and what the emphasized external IP adds.
 *  490 is the owner's choice for the simple-1112 bar (2026-11-18: 「加寬到約
 *  490，用原型字級」): 13px text and a 20px external IP. Measured in Chromium
 *  at scale 1, the bar's natural width is 441–501 for a typical status, 601
 *  for English "EXPOSED" with two 15-character addresses, and the external
 *  column alone needs at most 444 (519 emphasized) — so the external IP is
 *  whole at every scale and only the internal column ellipsizes. Emphasis
 *  renders that IP 1.4×: ~60pt more at scale 1. */
const HUD_BASE_W = 490
const HUD_EMPHASIS_W = 60

/** Window-width band the `overlay:autosize` handler enforces in main. The
 *  ceiling is the formula's own value at the largest scale with emphasis
 *  (round(490×1.75) + round(60×1.75) = 858 + 105), so no supported setting is
 *  ever cut short. It was 720, which clipped the bar from scale 1.5 up once the
 *  base became 490; a wider cap only matters to someone who chose 1.75. */
export const HUD_MIN_W = 380
export const HUD_MAX_W = 963
/** Height floor the `overlay:autosize` handler enforces, and what
 *  `hudWindowHeight` returns for an unmeasured content block. */
export const HUD_MIN_H = 46

/** Height the overlay window is *created* at, before the renderer has measured
 *  anything.
 *
 *  This used to be a bare `52` in `windows.ts` while `HUD_MIN_H`'s comment
 *  claimed to be "also the window's created height" — two numbers, neither
 *  matching, and nothing tying them together. The collapsed HUD at scale 1
 *  settles at 60: the bar's 42pt minimum (OverlayApp `BAR_MIN_H`) + the 18 of
 *  `HUD_CONTENT_CHROME`. (It was 58 with the 40pt bar before the simple-1112
 *  restyle; being born at 52 back then meant every HUD grew 6px the moment it
 *  first measured itself.)
 *
 *  Starting at the settled height removes that jump for the default, which is
 *  the case nearly every operator sees. A scaled or wrapped HUD still resizes
 *  on first measure — it has to; this is a starting guess, not a constraint. */
export const HUD_INITIAL_H = 60
/** Chrome around the measured content: outer 3px padding ×2, the 1px frame
 *  ×2, and 5px above and below the content inside the frame. Added before
 *  requesting. */
export const HUD_CONTENT_CHROME = 18

/**
 * Window width that fits the compact HUD bar at `scale`: `HUD_BASE_W` at scale
 * 1, scaled with the padding and type. The scale is clamped first (so it
 * matches the panel, which renders at the clamped scale) and the result to
 * [HUD_MIN_W, HUD_MAX_W] (so the requested width and the width main grants are
 * always the same number).
 */
export function hudWindowWidth(scale: number, emphasizeExternalIp: boolean): number {
  const s = clampHudScale(scale)
  const raw = Math.round(HUD_BASE_W * s) + (emphasizeExternalIp ? Math.round(HUD_EMPHASIS_W * s) : 0)
  return Math.max(HUD_MIN_W, Math.min(HUD_MAX_W, raw))
}

/** Window height for a measured content block. Returns the floor for a
 *  non-positive measurement (jsdom, or before first layout). */
export function hudWindowHeight(measuredContentHeight: number): number {
  if (!(measuredContentHeight > 0)) return HUD_MIN_H
  return Math.max(HUD_MIN_H, Math.round(measuredContentHeight) + HUD_CONTENT_CHROME)
}
