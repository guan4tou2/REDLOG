// Accelerators the main process registers. Kept in a leaf module with no
// imports so both `index.ts` (globalShortcut.register) and `tray.ts` (the menu
// item's accelerator label) read the same string instead of each writing out
// `CommandOrControl+Shift+M` and drifting.
//
// The renderer restates this in `src/renderer/src/lib/shortcuts.ts` — the two
// bundles share no module graph — and `test/shortcuts.test.ts` imports both to
// assert they still agree.

/** Quick mark. Registered globally, so it fires even when RedLog is not the
 *  focused application — the point is to capture a finding without breaking
 *  out of whatever tool the operator is in. */
export const QUICK_MARK_ACCELERATOR = 'CommandOrControl+Shift+M'

/** Leave HUD click-through. Registered globally on purpose: while pass-through
 *  is on, the HUD cannot be clicked and the app may not be focused, so a
 *  window-scoped binding would be unreachable exactly when it is needed
 *  (UIUX-STANDARD §8). */
export const HUD_PASSTHROUGH_ACCELERATOR = 'CommandOrControl+Shift+P'
