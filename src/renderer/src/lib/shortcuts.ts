// Single source of truth for RedLog's keyboard/pointer shortcuts, so the two
// places that surface them — the Dashboard "shortcuts" card (App.tsx) and the
// Timeline `?` cheatsheet (Timeline.tsx) — render from ONE list instead of two
// hand-maintained arrays that drifted apart (UX backlog F5: the card and the
// cheatsheet disagreed on which keys existed and what they did).
//
// This module is intentionally presentation-only: it does NOT wire up handlers
// (App.tsx and lib/timelineKeys.ts still own the actual keydown logic). It just
// describes what to show. Keeping it a plain data table means the two views
// can't drift, and the list is trivially testable.

export type ShortcutScope = 'global' | 'timeline'

export interface Shortcut {
  /** Stable machine identifier — never shown to the user, safe to key React on. */
  id: string
  /** Human-readable key combo. The modifier is the literal placeholder token
   *  `Mod` (see MOD_TOKEN); the render side swaps it for modKey(platform) so the
   *  registry stays platform-agnostic. Pointer affordances read literally
   *  (e.g. 'Alt+click', 'Right-click'). */
  keys: string
  /** Stable label identifier for the render side to map to display text. This is
   *  NOT an i18n key — callers already have their own translated strings for
   *  these actions; this only has to be a consistent, collision-free token. */
  labelKey: string
  scope: ShortcutScope
}

/** Placeholder the registry uses in place of a real modifier symbol. The render
 *  side replaces it with modKey(process.platform). */
export const MOD_TOKEN = 'Mod'

// Enumerated from the live handlers:
//   - global keys: App.tsx onKeyDown (⌘1..9 view nav, ⌘/ search, ⌘. pause) and
//     the main-process globalShortcut for ⌘⇧M quick marker.
//   - timeline keys: lib/timelineKeys.ts resolver (`/`, `?`, `f`, ↑/↓) plus the
//     ⌘K palette handler and the pointer affordances (Alt-click solo lane,
//     right-click drop marker) rendered in Timeline.tsx's cheatsheet.
export const SHORTCUTS: Shortcut[] = [
  // --- global (available everywhere) ---
  { id: 'switch-view', keys: `${MOD_TOKEN}+1..9`, labelKey: 'shortcut.switchView', scope: 'global' },
  { id: 'quick-marker', keys: `${MOD_TOKEN}+Shift+M`, labelKey: 'shortcut.quickMarker', scope: 'global' },
  { id: 'search', keys: `${MOD_TOKEN}+/`, labelKey: 'shortcut.search', scope: 'global' },
  { id: 'pause-recording', keys: `${MOD_TOKEN}+.`, labelKey: 'shortcut.pauseRecording', scope: 'global' },

  // --- timeline (only meaningful in the Timeline view) ---
  { id: 'filter-events', keys: '/', labelKey: 'shortcut.filterEvents', scope: 'timeline' },
  { id: 'toggle-help', keys: '?', labelKey: 'shortcut.toggleHelp', scope: 'timeline' },
  { id: 'focus-chain', keys: 'f', labelKey: 'shortcut.focusChain', scope: 'timeline' },
  { id: 'command-palette', keys: `${MOD_TOKEN}+K`, labelKey: 'shortcut.commandPalette', scope: 'timeline' },
  { id: 'navigate-events', keys: '↑/↓', labelKey: 'shortcut.navigateEvents', scope: 'timeline' },
  { id: 'solo-lane', keys: 'Alt+click', labelKey: 'shortcut.soloLane', scope: 'timeline' },
  { id: 'drop-marker', keys: 'Right-click', labelKey: 'shortcut.dropMarker', scope: 'timeline' }
]

/** Shortcuts relevant to a scope. 'global' returns only the always-on keys;
 *  'timeline' returns those global keys PLUS the timeline-only ones, since the
 *  Timeline view inherits every global shortcut. Order is preserved (globals
 *  first) so the render side gets a stable, sensible reading order. */
export function shortcutsForScope(scope: ShortcutScope): Shortcut[] {
  if (scope === 'global') return SHORTCUTS.filter((s) => s.scope === 'global')
  return SHORTCUTS.filter((s) => s.scope === 'global' || s.scope === scope)
}

/** The modifier symbol to substitute for MOD_TOKEN. macOS shows ⌘; everything
 *  else shows Ctrl. Takes the platform string (e.g. process.platform) so it
 *  stays a pure function and is trivially testable. */
export function modKey(platform: string): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl'
}
