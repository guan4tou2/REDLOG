// The navigation order (docs/UIUX-STANDARD.md §5.3).
//
// This used to be a user-reorderable list persisted to localStorage, with
// load/save/subscribe machinery and a drag gesture in the sidebar. §5.3 fixes
// it instead: ⌘1..6 and ⌘9 always mean the same view, and the number is printed on
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

// Five daily workspaces plus the optional built-in terminal. Detail routes
// stay addressable for evidence links; they do not take primary shortcuts.
export const DEFAULT_ORDER: SidebarViewId[] = [
  'dashboard', 'search', 'http_history', 'targets', 'screenshots', 'terminal'
]
export const NUMBERED_SLOTS = 6

export function primaryViewFor(view: string): string {
  if(view==='timeline'||view==='transcript')return 'search'
  if(view==='scope')return 'targets'
  if(view==='loot'||view==='bookmarks')return 'screenshots'
  return view
}

export function primaryLabelKey(view: string): string {
  return view==='screenshots'?'sidebar.evidence':view==='targets'?'sidebar.targetsScope':view==='http_history'?'sidebar.httpHistory':`sidebar.${view}`
}

export function shortcutNumberFor(id: SidebarViewId): number | null {
  const i = DEFAULT_ORDER.indexOf(id)
  return i >= 0 && i < NUMBERED_SLOTS ? i + 1 : null
}
