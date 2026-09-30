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

/** What "normal" renders at. The ladder is stated RELATIVE to this, so normal
 *  reads 100% instead of 90% -- a default that calls itself ninety percent of
 *  something invites the question "ninety percent of what", and the answer was
 *  an implementation detail. The base is the answer, and it stays in here. */
export const BASE_ZOOM = 0.9

export const DEFAULT_UI_SCALE = 1
export const MAX_UI_SCALE = 1.6

export const UI_SCALE_OPTIONS: ReadonlyArray<{ value: number; labelKey: string }> = [
  { value: 1, labelKey: 'settings.uiScale.normal' },
  { value: 1.1, labelKey: 'settings.uiScale.large' },
  { value: 1.25, labelKey: 'settings.uiScale.xlarge' },
  { value: 1.4, labelKey: 'settings.uiScale.xxlarge' }
]

/** Anything unparseable, out of range, or absent reads as the default. */
export function parseUiScale(raw: string | null): number {
  const parsed = parseFloat(raw || '')
  if (!Number.isFinite(parsed)) return DEFAULT_UI_SCALE
  if (parsed < DEFAULT_UI_SCALE || parsed > MAX_UI_SCALE) return DEFAULT_UI_SCALE
  return parsed
}

/** The number that reaches CSS. Rounded because `1.25 * 0.9` is not 1.125 in
 *  binary and a zoom of 1.1250000000000002 is a diff nobody wants to read. */
export function zoomFor(scale: number): number {
  return Math.round(scale * BASE_ZOOM * 1000) / 1000
}
