// Terminal font size, shared by the key bindings and the persisted value.
//
// The two used to carry their own bounds: the parser accepted 8–32 and the
// keyboard had none, so a held ⌘+ could persist a size the next launch would
// reject. One range, one place.

export const FONT_MIN = 8
export const FONT_MAX = 32
export const DEFAULT_FONT_SIZE = 13

/** Keeps a requested size inside the range the parser accepts. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)))
}
