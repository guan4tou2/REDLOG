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

export type ShortcutScope = 'nav' | 'app' | 'terminal' | 'timeline'

export interface ShortcutRow {
  /** Stable identity. The handler dispatches on it; the table describes it. */
  id: string
  /** Keys drawn the way the current platform writes them. */
  keys: string
  /** i18n key of the description. */
  label: string
  scope: ShortcutScope
  /**
   * True when this keyboard event is this shortcut. Present on rows the app
   * binds itself; absent on mouse gestures and on rows whose handler lives
   * somewhere this module cannot see (the Terminal's tab keys are scoped to a
   * mounted view). A row without a matcher is documentation only — which is
   * still the point, since an undocumented binding is the failure this table
   * exists to prevent.
   */
  match?: (e: KeyboardEvent) => boolean
}

const mod = (e: KeyboardEvent): boolean => e.metaKey || e.ctrlKey
/** Plain ⌘/Ctrl — no Shift, no Alt. Keeps ⌘K from also firing on ⌘⇧K. */
const plainMod = (e: KeyboardEvent): boolean => mod(e) && !e.shiftKey && !e.altKey

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
  const m = isMac ? '⌘' : 'Ctrl+'
  const nav: ShortcutRow[] = order.map((view, i) => ({
    id: `nav:${view}`,
    keys: `${m}${i + 1}`,
    // The sidebar calls the screenshots view "screens"; the i18n keys follow
    // the sidebar, not the view id.
    label: `sidebar.${view === 'screenshots' ? 'screens' : view}`,
    scope: 'nav',
    match: (e) => plainMod(e) && e.key === String(i + 1)
  }))
  nav.push({
    id: 'nav:settings',
    keys: `${m}9`,
    label: 'sidebar.settings',
    scope: 'nav',
    match: (e) => plainMod(e) && e.key === '9'
  })

  return [
    ...nav,
    {
      id: 'app:search', keys: `${m}/`, label: 'dashboard.search', scope: 'app',
      match: (e) => mod(e) && (e.key === '/' || e.code === 'Slash')
    },
    {
      id: 'app:palette', keys: `${m}K`, label: 'dashboard.palette', scope: 'app',
      match: (e) => mod(e) && (e.key === 'k' || e.key === 'K')
    },
    {
      id: 'app:toggleRecording', keys: `${m}.`, label: 'dashboard.toggleRecording', scope: 'app',
      match: (e) => mod(e) && e.key === '.'
    },
    {
      id: 'app:addMarker',
      keys: formatAccelerator(QUICK_MARK_ACCELERATOR, isMac),
      label: 'dashboard.addMarker',
      scope: 'app'
      // Registered by the main process as a global accelerator, so the
      // renderer never sees the key — documentation only, deliberately.
    },
    {
      id: 'app:hudCorner',
      keys: isMac ? '⌘⇧⌥↑↓←→' : 'Ctrl+Shift+Alt+↑↓←→',
      label: 'dashboard.hudCorner',
      scope: 'app',
      match: (e) => mod(e) && e.altKey && e.shiftKey && HUD_ARROWS.includes(e.key)
    },
    { id: 'term:new', keys: `${m}T`, label: 'dashboard.terminalNewTab', scope: 'terminal' },
    { id: 'term:close', keys: `${m}W`, label: 'dashboard.terminalCloseTab', scope: 'terminal' },
    { id: 'term:cycle', keys: isMac ? '⌘⇧[ ]' : 'Ctrl+Shift+[ ]', label: 'dashboard.terminalCycleTab', scope: 'terminal' }
  ]
}

export const HUD_ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

/**
 * Timeline-scoped keys and gestures, for the `?` panel. Grouped the way the
 * panel renders them. These live here rather than inline in Timeline.tsx for
 * the same reason the app-level ones do: a binding and its documentation
 * drift the moment they are written in two places.
 */
export interface ShortcutGroup {
  label: string
  rows: Array<{ keys: string; label: string }>
}

export function timelineShortcuts(isMac: boolean): ShortcutGroup[] {
  const m = isMac ? '⌘' : 'Ctrl+'
  return [
    {
      label: 'timeline.help.group.filter',
      rows: [
        { keys: '/', label: 'timeline.help.slash' },
        { keys: `${m}K`, label: 'timeline.help.palette' },
        { keys: 'Alt-click', label: 'timeline.help.soloLane' },
        { keys: 'Esc', label: 'timeline.help.escFilter' }
      ]
    },
    {
      label: 'timeline.help.group.focus',
      rows: [
        { keys: 'f', label: 'timeline.help.focusChain' },
        { keys: 'click', label: 'timeline.help.selectDot' },
        { keys: '↑/↓', label: 'timeline.help.walk' }
      ]
    },
    {
      label: 'timeline.help.group.timeline',
      rows: [
        { keys: 'Right-click', label: 'timeline.help.dropMarker' },
        { keys: 'drag minimap', label: 'timeline.help.zoom' },
        { keys: 'click cluster', label: 'timeline.help.expandCluster' }
      ]
    },
    {
      label: 'timeline.help.group.detail',
      rows: [
        { keys: 'click ▶', label: 'timeline.help.expandBody' },
        { keys: 'click cause chip', label: 'timeline.help.jumpCause' },
        { keys: 'Copy full', label: 'timeline.help.copyFull' }
      ]
    },
    {
      label: 'timeline.help.group.misc',
      rows: [{ keys: '?', label: 'timeline.help.thisMenu' }]
    }
  ]
}
