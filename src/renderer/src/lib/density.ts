// Density — the second display axis (docs/UIUX-STANDARD.md §3).
//
// `--app-zoom` scales everything: text, icons, images, layout. Density changes
// only row heights and padding, through the `--row-h` / `--pad` / `--gap` /
// `--section-gap` variables defined in styles/index.css. The two are
// orthogonal on purpose, because they answer different questions — zoom is
// "I need this bigger", density is "I need more of it on screen".
//
// They interact in one place. Raising the zoom pushes rows off the bottom of
// the window, which is the opposite of what an operator watching a live
// engagement wants, so a raised scale implies tight density unless the user has
// said otherwise. An explicit choice always wins and is remembered.

export type Density = 'comfortable' | 'tight'

export const DENSITY_KEY = 'redlog-density'
/** At or above this SCALE — the relative number in Settings, where normal is
 *  1 — density goes tight unless the operator picked one explicitly. Stated in
 *  scale rather than in the zoom that reaches CSS because the two disagreed:
 *  the settings page compared the scale and main.tsx compared the zoom, so 特大
 *  was tight until you reloaded and comfortable afterwards. */
export const AUTO_TIGHT_SCALE = 1.25

/** The density to use given the current zoom and whatever the user has chosen.
 *  `stored` is `null` when they have never chosen. */
export function resolveDensity(scale: number, stored: string | null): Density {
  if (stored === 'comfortable' || stored === 'tight') return stored
  return scale >= AUTO_TIGHT_SCALE ? 'tight' : 'comfortable'
}

/** Reflect the density onto the document. `styles/index.css` keys the variable
 *  overrides off `:root[data-density='tight']`; comfortable is the bare `:root`
 *  default, so the attribute is removed rather than set to a second value. */
export function applyDensity(density: Density): void {
  if (density === 'tight') document.documentElement.setAttribute('data-density', 'tight')
  else document.documentElement.removeAttribute('data-density')
}

/** Read the stored preference, tolerating a disabled or full localStorage. */
export function storedDensity(): string | null {
  try { return localStorage.getItem(DENSITY_KEY) } catch { return null }
}
