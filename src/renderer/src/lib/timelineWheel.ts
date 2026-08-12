// One pure decision for what a wheel event does over the Timeline track. It
// replaces the invisible branch in Timeline.tsx's wheel handler where a plain
// wheel silently flipped between horizontal pan and vertical scroll depending
// on whether the lane stack overflowed the viewport — the surprising behaviour
// nobody could see or reason about. Lifting the decision into a pure function of
// (overflow, shiftKey, zoomKey) makes the precedence written down, testable, and
// impossible to get into an ambiguous state; it is also exactly the table that
// T2(b) annotates on-screen for the one row that surprises operators.
//
// Style note: mirrors lib/timelineKeys.ts — a single pure resolver, precedence
// commented row by row, no DOM or event coupling. Callers compute the three
// booleans (overflow = laneStack.scrollHeight > clientHeight + 1) and act on the
// returned mode.

export interface WheelContext {
  /** the lane stack is taller than its viewport: scrollHeight > clientHeight + 1 */
  overflow: boolean
  /** the Shift key is held — overrides scroll-y back to horizontal pan */
  shiftKey: boolean
  /** the zoom modifier is held: ctrlKey || metaKey (trackpad pinch reports ctrl) */
  zoomKey: boolean
}

export type WheelMode =
  | 'zoom' // cursor-anchored zoom (zoom modifier wins over everything)
  | 'pan-x' // horizontal pan of the time axis (the common, unsurprising case)
  | 'scroll-y' // vertical scroll to reach lanes clipped below the fold

export function wheelMode(ctx: WheelContext): WheelMode {
  // The zoom modifier wins unconditionally — shift and overflow are irrelevant
  // once the operator is asking to zoom. This is the top row of the T2 matrix.
  if (ctx.zoomKey) return 'zoom'

  // With no overflow the stack already fits, so vertical scroll is meaningless;
  // a plain wheel always pans the time axis. This is the common case, unchanged.
  if (!ctx.overflow) return 'pan-x'

  // Overflow from here down. Shift is the explicit escape hatch: hold it to keep
  // panning the time axis instead of scrolling the clipped lanes into view.
  if (ctx.shiftKey) return 'pan-x'

  // Overflow, no modifier: the one surprising row. A plain wheel scrolls the lane
  // stack so the operator can reach lanes clipped below the fold — and T2(b)'s
  // inline hint appears precisely here to explain the gesture as it happens.
  return 'scroll-y'
}
