// Landing on one source's row in Settings (#590). A row that a link can land on
// carries `data-source-id` (the capture health id) and is focusable without
// being a tab stop, so the landing is visible and a keyboard or screen-reader
// user starts at that row rather than at the top of the page.

/** Classes of a row a link can land on; pair with `tabIndex={-1}`. */
export const SOURCE_ROW = 'scroll-mt-4 rounded outline-none focus:ring-1 focus:ring-redlog-accent'

export function landOnSourceRow(el: HTMLElement | null): void {
  if (!el) return
  el.scrollIntoView?.({ block: 'center' })
  el.focus?.({ preventScroll: true })
}
