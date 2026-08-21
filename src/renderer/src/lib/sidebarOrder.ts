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
  | 'targets' | 'scope' | 'loot' | 'marks' | 'search'

// `transcript` sits next to `timeline` — same events, read the other way, and
// `search` between them because finding evidence afterwards is a core use
// rather than a detour.
//
// Ten entries, eight numbered slots (⌘9 is Settings), so the last two —
// `loot` and `marks` — carry no chord. That is a real cost and it is taken
// deliberately: both are reachable from the sidebar and from ⌘K, and neither
// is somewhere an operator jumps mid-keystroke the way they jump to the
// timeline or to search.
export const DEFAULT_ORDER: SidebarViewId[] = [
  'dashboard', 'timeline', 'search', 'transcript', 'terminal', 'screenshots', 'targets', 'scope', 'loot', 'marks'
]
