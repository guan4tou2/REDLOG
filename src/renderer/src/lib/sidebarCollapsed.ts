// Is the sidebar an icon rail?
//
// An appearance preference, so it lives with zoom, density, locale and the
// terminal font: in localStorage, not in the project config — the config
// travels in the hand-off profile and is rewritten wholesale on every save, so
// a teammate receiving one would inherit the sender's sidebar.
//
// Global rather than per project, unlike the "show every page" opt-out: that
// one is a statement about an engagement's data, this one is a statement about
// how the operator likes their window.

const KEY = 'redlog-sidebar-collapsed'

/** Fired after a write so a listening component re-reads without a reload. */
export const SIDEBAR_COLLAPSED_EVENT = 'redlog:sidebar-collapsed'

/** Expanded unless explicitly collapsed. Unreadable storage reads as expanded:
 *  labels are the safe default, because an icon rail has to be learned. */
export function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setSidebarCollapsed(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // A private window or blocked storage: the toggle simply does not stick.
  }
  try {
    window.dispatchEvent(new CustomEvent(SIDEBAR_COLLAPSED_EVENT, { detail: { on } }))
  } catch { /* no window (tests) */ }
}
