// Page layout (UIUX-STANDARD §27). Every page fills the main pane and starts
// at the pane's left padding; the padding stays on the scrolling parent so the
// scrollbar sits at the window edge. Nothing here caps or centres a page.

/** The body of a page: the full width of the pane, no cap, no centring. */
export const PAGE_BODY = 'w-full min-w-0'

/** Running prose (explanations, hints, descriptions) keeps a readable line
 *  length and stays left-aligned. A card, list, table or control row is not
 *  prose and does not use this. */
export const PROSE_WIDTH = 'max-w-[72ch]'

/** On a page body that scrolls under a fixed header: the scrollbar's gutter is
 *  kept whether or not the body overflows, so its right edge does not move
 *  when the content grows past the pane. */
export const SCROLL_GUTTER = '[scrollbar-gutter:stable]'

/** The last child of a fixed header above a `SCROLL_GUTTER` body. An empty box
 *  that keeps the same gutter is exactly one scrollbar wide (zero where the
 *  platform overlays its scrollbars), so the header's right edge lines up with
 *  the body's. Nothing in it can be clipped: it has no content. */
export const HEADER_GUTTER = 'shrink-0 overflow-y-hidden [scrollbar-gutter:stable]'
