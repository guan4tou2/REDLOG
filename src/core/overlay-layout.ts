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
