// How big the interface is drawn.
//
// `--app-zoom` on `<body>` scales everything — text, icons, rules, padding —
// so this is one number, not a font-size override that would drift away from
// the icons beside it. The type scale's 13px floor (docs/UIUX-STANDARD.md §2)
// is measured at 1.0; the ladder starts below it because the floor is about
// what a glyph needs, and a whole interface scaled down as a unit stays
// legible where shrunk text alone would not.
//
// The default is the bottom of the ladder on purpose. RedLog is read beside
// other windows during an engagement — a terminal, a browser, notes — and the
// operator is looking for density, not for comfortable reading. Everything
// above the default exists for the people who need it bigger.
//
// A personal viewing preference, so localStorage rather than the project
// config: the config travels in the hand-off profile, and a teammate opening
// one should not inherit the sender's eyesight.

export const UI_SCALE_KEY = 'redlog-app-zoom'

/** Also the floor. Mirrored by the `var(--app-zoom, 0.9)` fallbacks in
 *  styles/index.css, which is what renders when localStorage is unreadable. */
export const DEFAULT_UI_SCALE = 0.9
export const MAX_UI_SCALE = 1.5

export const UI_SCALE_OPTIONS: ReadonlyArray<{ value: number; labelKey: string }> = [
  { value: 0.9, labelKey: 'settings.uiScale.normal' },
  { value: 1.0, labelKey: 'settings.uiScale.large' },
  { value: 1.15, labelKey: 'settings.uiScale.xlarge' },
  { value: 1.3, labelKey: 'settings.uiScale.xxlarge' }
]

/** Anything unparseable, out of range, or absent reads as the default —
 *  including the value a previous build wrote, which is still in range. */
export function parseUiScale(raw: string | null): number {
  const parsed = parseFloat(raw || '')
  if (!Number.isFinite(parsed)) return DEFAULT_UI_SCALE
  if (parsed < DEFAULT_UI_SCALE || parsed > MAX_UI_SCALE) return DEFAULT_UI_SCALE
  return parsed
}
