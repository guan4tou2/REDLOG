// The escape hatch for §22's progressive disclosure: show every page at once.
//
// Per PROJECT, not globally. Switching projects reloads the same origin, so a
// global key would mean one tick during one engagement turns disclosure off for
// every engagement afterwards — the operator would have opted out of something
// they only wanted off once. Same reasoning, and the same shape, as the
// Timeline's per-project view keys.
//
// localStorage rather than config.yaml, matching every other appearance
// preference (zoom, density, locale, terminal font): the project config travels
// in the hand-off profile and is rewritten wholesale on every save, so a
// teammate receiving a profile would inherit the sender's sidebar preferences
// along with the engagement's scope.

const PREFIX = 'redlog-show-all-pages'

/** Fired after a write so a listening App re-reads without a reload. */
export const SHOW_ALL_PAGES_EVENT = 'redlog:show-all-pages'

export function showAllPagesKey(projectId: string): string {
  return `${PREFIX}:${projectId}`
}

/** Off unless explicitly turned on. Anything unreadable reads as off — the
 *  default is the behaviour §22 specifies, so a storage failure lands on the
 *  design rather than away from it. */
export function storedShowAllPages(projectId: string | null | undefined): boolean {
  if (!projectId) return false
  try {
    return localStorage.getItem(showAllPagesKey(projectId)) === '1'
  } catch {
    return false
  }
}

export function setShowAllPages(projectId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(showAllPagesKey(projectId), '1')
    else localStorage.removeItem(showAllPagesKey(projectId))
  } catch {
    // A private window or blocked storage: the toggle simply does not stick.
  }
  try {
    window.dispatchEvent(new CustomEvent(SHOW_ALL_PAGES_EVENT, { detail: { projectId, on } }))
  } catch { /* no window (tests) */ }
}
