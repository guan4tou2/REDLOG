// Shared source of truth for the keyboard-shortcut cheatsheet, in the same
// spirit as sidebarOrder.ts. The Dashboard used to hand-write its own list of
// key/label pairs, so every shortcut added to App.tsx's keydown handler after
// that list was written stayed invisible: ⌘K (fuzzy palette), ⌘. (pause and
// resume recording), ⌘⇧⌥+Arrow (snap the HUD to a corner) and the Terminal's
// four tab bindings were all live and undocumented. Anything the app binds
// belongs in the table below; a surface that wants to show shortcuts renders
// from it rather than restating them.
//
// Behaviour still lives with the handlers — this table describes, it does not
// dispatch. That is a deliberate limit: wiring dispatch through here would
// mean routing Timeline's and Terminal's view-scoped handlers through a global
// registry for the sake of a help panel. Keeping it descriptive costs one
// discipline, which the header comment above states: bind a key, add a row.

/** Electron accelerator for quick-mark. Mirrors `QUICK_MARK_ACCELERATOR` in
 *  `src/core/shortcuts.ts` — the main and renderer bundles share no module
 *  graph (see ARCHITECTURE.md; renderer types are hand-mirrored too), so this
 *  is restated rather than imported. `test/shortcuts.test.ts` imports both and
 *  fails if they drift apart. */
export const QUICK_MARK_ACCELERATOR = 'CommandOrControl+Shift+M'

export type ShortcutScope = 'nav' | 'app' | 'terminal'

export interface ShortcutRow {
  /** Keys drawn the way the current platform writes them. */
  keys: string
  /** i18n key of the description. */
  label: string
  scope: ShortcutScope
}

const MAC_GLYPH: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Control: '⌃',
  Shift: '⇧',
  Alt: '⌥'
}

/** Draw an Electron accelerator the way each platform writes it: glyphs run
 *  together on macOS (`⌘⇧M`), spelled-out and plus-joined elsewhere
 *  (`Ctrl+Shift+M`). */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator.split('+')
  return isMac
    ? parts.map((p) => MAC_GLYPH[p] ?? p).join('')
    : parts.map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p)).join('+')
}

/** Every shortcut the app binds, in the order the cheatsheet shows them.
 *  `order` is the live sidebar order so the ⌘1..8 rows follow a drag-reorder;
 *  Settings is pinned to ⌘9 and is not part of that order. */
export function appShortcuts(order: readonly string[], isMac: boolean): ShortcutRow[] {
  const mod = isMac ? '⌘' : 'Ctrl+'
  const nav: ShortcutRow[] = order.map((view, i) => ({
    keys: `${mod}${i + 1}`,
    // The sidebar calls the screenshots view "screens"; the i18n keys follow
    // the sidebar, not the view id.
    label: `sidebar.${view === 'screenshots' ? 'screens' : view}`,
    scope: 'nav'
  }))
  nav.push({ keys: `${mod}9`, label: 'sidebar.settings', scope: 'nav' })

  return [
    ...nav,
    { keys: `${mod}/`, label: 'dashboard.search', scope: 'app' },
    { keys: `${mod}K`, label: 'dashboard.palette', scope: 'app' },
    { keys: `${mod}.`, label: 'dashboard.toggleRecording', scope: 'app' },
    { keys: formatAccelerator(QUICK_MARK_ACCELERATOR, isMac), label: 'dashboard.addMarker', scope: 'app' },
    { keys: isMac ? '⌘⇧⌥↑↓←→' : 'Ctrl+Shift+Alt+↑↓←→', label: 'dashboard.hudCorner', scope: 'app' },
    { keys: `${mod}T`, label: 'dashboard.terminalNewTab', scope: 'terminal' },
    { keys: `${mod}W`, label: 'dashboard.terminalCloseTab', scope: 'terminal' },
    { keys: isMac ? '⌘⇧[ ]' : 'Ctrl+Shift+[ ]', label: 'dashboard.terminalCycleTab', scope: 'terminal' }
  ]
}
