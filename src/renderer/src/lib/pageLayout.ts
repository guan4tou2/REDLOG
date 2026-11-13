// Page layout (UIUX-STANDARD §27). Every page fills the main pane and starts
// at the pane's left padding; the padding stays on the scrolling parent so the
// scrollbar sits at the window edge. Nothing here caps or centres a page.

/** The body of a page: the full width of the pane, no cap, no centring. */
export const PAGE_BODY = 'w-full min-w-0'

/** Running prose (explanations, hints, descriptions) keeps a readable line
 *  length and stays left-aligned. A card, list, table or control row is not
 *  prose and does not use this. */
export const PROSE_WIDTH = 'max-w-[72ch]'
