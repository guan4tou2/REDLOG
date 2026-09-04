// The navigation order (docs/UIUX-STANDARD.md §5.3).
//
// This used to be a user-reorderable list persisted to localStorage, with
// load/save/subscribe machinery and a drag gesture in the sidebar. §5.3 fixes
// it instead: ⌘1..9 always means the same view, and the number is printed on
// the row.
//
// Those two facts depend on each other. While rows could be dragged, the
// number was a property of the operator's current arrangement rather than of
// the view, so printing it would have taught the wrong thing — and ⌘2 had in
// fact already drifted off the sidebar once, which is why the shared order
// module was created in the first place. Fixing the order is what lets the
// number be shown, and showing the number is what makes the shortcut
// learnable without the ? panel.
//
// Settings is not in this list: it is pinned to ⌘9 at the bottom of the
// sidebar and is not part of the numbered run.

export type SidebarViewId =
  | 'dashboard' | 'timeline' | 'transcript' | 'terminal' | 'screenshots'
  | 'targets' | 'scope' | 'loot' | 'bookmarks' | 'search' | 'http_history'

// `transcript` sits next to `timeline` — same events, read the other way, and
// `search` between them because finding evidence afterwards is a core use
// rather than a detour.
//
// Eleven entries, eight numbered slots (⌘9 is Settings), so the last three —
// `scope`, `loot` and `bookmarks` — carry no chord. That is a real cost and it is
// taken deliberately: all three are reachable from the sidebar and from ⌘K, and
// none is somewhere an operator jumps mid-keystroke the way they jump to the
// timeline or to search.
export const DEFAULT_ORDER: SidebarViewId[] = [
  'dashboard', 'timeline', 'search', 'transcript', 'http_history', 'terminal', 'screenshots', 'targets', 'scope', 'loot', 'bookmarks'
]

/** ⌘1..⌘8 belong to views; ⌘9 is pinned to Settings, which sits outside this
 *  list. */
export const NUMBERED_SLOTS = 8

/**
 * The number a view wears, or null when it has no chord.
 *
 * Derived from the view's position in DEFAULT_ORDER, never from where it
 * happens to be rendered. Those were the same thing while every row was always
 * shown, and the sidebar printed the rendered index — which is why it has been
 * printing 9, 10 and 11 beside three rows that have no chord at all, and a
 * second "9" beside Settings' own. Once rows can be hidden the two diverge
 * completely: the chord would keep opening the timeline while the row beside it
 * claimed a different number.
 */
export function shortcutNumberFor(id: SidebarViewId): number | null {
  const i = DEFAULT_ORDER.indexOf(id)
  return i >= 0 && i < NUMBERED_SLOTS ? i + 1 : null
}
