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
// engagement wants, so a raised zoom implies tight density unless the user has
// said otherwise. An explicit choice always wins and is remembered.

export type Density = 'comfortable' | 'tight'

export const DENSITY_KEY = 'redlog-density'
/** Above this zoom, density goes tight unless the user picked one explicitly. */
export const AUTO_TIGHT_ZOOM = 1.15

/** The density to use given the current zoom and whatever the user has chosen.
 *  `stored` is `null` when they have never chosen. */
export function resolveDensity(zoom: number, stored: string | null): Density {
  if (stored === 'comfortable' || stored === 'tight') return stored
  return zoom >= AUTO_TIGHT_ZOOM ? 'tight' : 'comfortable'
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
