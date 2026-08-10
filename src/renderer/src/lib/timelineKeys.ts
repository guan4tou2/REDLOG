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
}

export type TimelineKeyAction =
  | 'none'
  | 'focus-filter' // '/'  → focus the header filter input
  | 'toggle-help' // '?'  → toggle the shortcut cheatsheet
  | 'close-help' // Escape, help modal open (highest precedence)
  | 'exit-focus' // Escape, focus-chain active
  | 'close-detail' // Escape, detail panel open
  | 'nav-prev' // ArrowUp with a detail panel open
  | 'nav-next' // ArrowDown with a detail panel open
  | 'toggle-focus' // 'f'  → enter/exit focus-chain mode

interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
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
    return 'none'
  }

  // Arrow navigation belongs to the detail panel — it walks the selected event.
  // With no panel open, arrows must fall through to normal scrolling.
  if (e.key === 'ArrowUp') return ctx.hasDetail ? 'nav-prev' : 'none'
  if (e.key === 'ArrowDown') return ctx.hasDetail ? 'nav-next' : 'none'

  // The letter/symbol affordances never fire with a modifier held, so they
  // can't shadow ⌘K, ⌘F, and friends.
  if (e.metaKey || e.ctrlKey || e.altKey) return 'none'
  if (e.key === '/') return 'focus-filter'
  if (e.key === '?') return 'toggle-help'
  if (e.key === 'f' || e.key === 'F') return 'toggle-focus'

  return 'none'
}
