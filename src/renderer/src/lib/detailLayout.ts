// Where the Timeline's detail panel sits: under the list, or beside it.
//
// It is a real trade, not a preference about neatness, which is why it is a
// control and not a decision made once in the code.
//
//   bottom  the panel spans the full width, so a long command's stdout, an
//           HTTP request with its headers, or an agent turn reads without
//           wrapping — at the cost of half the rows the list can show
//   right   the list keeps its full height for scanning, and the panel gets a
//           column it has to wrap inside
//
// Which one is right depends on what the operator is doing in the next ten
// minutes — reading one capture closely, or sweeping the record for something
// — and that changes several times a day. So it lives on the Timeline's own
// toolbar rather than in Settings: a switch you reach for while working does
// not belong two pages away from the work.
//
// Global rather than per project, like the sidebar rail: it is a statement
// about how this operator reads, not about this engagement's data.

const KEY = 'redlog-timeline-detail-layout'

export type DetailLayout = 'bottom' | 'right'

/** Fired after a write so a listening component re-reads without a reload. */
export const DETAIL_LAYOUT_EVENT = 'redlog:detail-layout'

/** Bottom unless explicitly changed. The wide content this app captures —
 *  stdout, headers, prompts — is what the panel is usually opened for. */
export function storedDetailLayout(): DetailLayout {
  try {
    return localStorage.getItem(KEY) === 'right' ? 'right' : 'bottom'
  } catch {
    return 'bottom'
  }
}

export function setDetailLayout(layout: DetailLayout): void {
  try {
    if (layout === 'right') localStorage.setItem(KEY, 'right')
    else localStorage.removeItem(KEY)
  } catch {
    // A private window or blocked storage: the choice simply does not stick.
  }
  try {
    window.dispatchEvent(new CustomEvent(DETAIL_LAYOUT_EVENT, { detail: { layout } }))
  } catch { /* no window (tests) */ }
}
