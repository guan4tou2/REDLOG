// One pure decision for the Timeline's global single-key surface. It replaces
// four separate window keydown listeners — each of which re-implemented the
// "am I typing in a field?" guard, and three of which independently handled
// Escape — so a single Escape press could fire "close detail", "exit focus" and
// "close help" all at once. Making this a pure function of (key, context) means
// the precedence is written down, testable, and impossible to get into an
// ambiguous state.
//
// Scope note: the ⌘K command palette keeps its own handler. This resolver owns
// only the plain single-key affordances that share the "not while typing" rule.

export interface TimelineKeyContext {
  /** focus is inside an input/textarea/contenteditable — suppress everything */
  inField: boolean
  /** the event detail panel is open */
  hasDetail: boolean
  /** the keyboard-shortcut cheatsheet modal is open */
  helpOpen: boolean
  /** focus-chain mode is active */
  focusActive: boolean
  /** an event is selected (the selection ring is drawn) */
  hasSelection?: boolean
}

export type TimelineKeyAction =
  | 'none'
  | 'focus-filter' // '/'  → focus the header filter input
  | 'toggle-help' // '?'  → toggle the shortcut cheatsheet
  | 'close-help' // Escape, help modal open (highest precedence)
  | 'exit-focus' // Escape, focus-chain active
  | 'close-detail' // Escape, detail panel open
  | 'clear-selection' // Escape, an event selected but no panel open
  | 'nav-prev' // ←  previous event in the same lane
  | 'nav-next' // →  next event in the same lane
  | 'nav-lane-up' // ↑  nearest event in time, one lane up
  | 'nav-lane-down' // ↓  nearest event in time, one lane down
  | 'nav-state-prev' // ⇧← previous event carrying state
  | 'nav-state-next' // ⇧→ next event carrying state
  | 'nav-first' // Home
  | 'nav-last' // End
  | 'zoom-in' // +
  | 'zoom-out' // −
  | 'zoom-reset' // 0
  | 'toggle-detail' // Enter → open/close the Inspector on the selection
  | 'toggle-focus' // 'f'  → enter/exit focus-chain mode

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey?: boolean
}

export function resolveTimelineKey(e: KeyLike, ctx: TimelineKeyContext): TimelineKeyAction {
  // The single guard that used to be copied into every handler. While the
  // operator is typing, none of these shortcuts exist.
  if (ctx.inField) return 'none'

  // Escape: exactly one action, chosen by precedence. A modal overlay wins over
  // an in-canvas mode, which wins over the detail side-panel — so the operator
  // dismisses the top-most thing first and a second Escape peels the next layer.
  if (e.key === 'Escape') {
    if (ctx.helpOpen) return 'close-help'
    if (ctx.focusActive) return 'exit-focus'
    if (ctx.hasDetail) return 'close-detail'
    // §5.7 peels one layer at a time, and the selection is now a layer of its
    // own: closing the Inspector leaves the ring, and the next Escape drops it.
    if (ctx.hasSelection) return 'clear-selection'
    return 'none'
  }

  // §6 movement. Arrows navigate the *selection*, which exists independently
  // of the Inspector now — the two used to be the same thing, so an operator
  // could not walk the timeline without a panel covering a third of it.
  //   ← →  stay in the lane. A lane is one producer, so this reads its story.
  //   ↑ ↓  change lane and land on the nearest event in time, which is what
  //        "what else was happening then" means.
  //   ⇧← ⇧→ skip to the next event that carries state — a non-zero exit, a
  //        scope violation, loot. The dense middle of a run is mostly noise.
  if (e.metaKey || e.ctrlKey || e.altKey) return 'none'
  if (e.key === 'ArrowLeft') return e.shiftKey ? 'nav-state-prev' : 'nav-prev'
  if (e.key === 'ArrowRight') return e.shiftKey ? 'nav-state-next' : 'nav-next'
  if (e.key === 'ArrowUp') return 'nav-lane-up'
  if (e.key === 'ArrowDown') return 'nav-lane-down'
  if (e.key === 'Home') return 'nav-first'
  if (e.key === 'End') return 'nav-last'
  if (e.key === 'Enter') return ctx.hasSelection ? 'toggle-detail' : 'none'

  // Zoom, anchored on the selection rather than the viewport centre (§6).
  // `=` because + is shift-equals on most layouts and demanding the shift
  // makes a frequent key awkward.
  if (e.key === '+' || e.key === '=') return 'zoom-in'
  if (e.key === '-' || e.key === '_') return 'zoom-out'
  if (e.key === '0') return 'zoom-reset'

  // The letter/symbol affordances never fire with a modifier held, so they
  // can't shadow ⌘K, ⌘F, and friends.
  if (e.key === '/') return 'focus-filter'
  if (e.key === '?') return 'toggle-help'
  if (e.key === 'f' || e.key === 'F') return 'toggle-focus'

  return 'none'
}
