// Which keyboard the operator is looking at (docs/UIUX-STANDARD.md §5.7).
//
// Five modules had grown their own copy of this, and four of them wrote it as
// `platform !== 'win32'`. On Linux that is true, so every Linux operator was
// shown `⌘` — a key their keyboard does not have — in the sidebar tooltips,
// the status bar, the Timeline and the `?` panel. The test that pinned the
// shortcut table never caught it because `shortcuts.ts` correctly takes
// `isMac` as a parameter; the error was in what every caller passed it.
//
// The bug survives being fixed in one place, too: rewriting a call site as
// `=== 'win32' ? 'Ctrl+' : '⌘'` moves the mistake to the other side of the
// same check and still shows Linux a Command key. The question is not "is
// this Windows" — it is "is this a Mac", and only `darwin` answers yes.
//
// Read defensively: this module is imported in tests where the preload bridge
// is absent. Defaulting to non-Mac is the safer wrong answer — `Ctrl+` is at
// least a key that exists everywhere.

const platform = (window as { redlog?: { platform?: string } }).redlog?.platform

/** True only on macOS. Everything else — Windows and Linux — uses Ctrl. */
export const isMac = platform === 'darwin'

/** The modifier prefix as this platform writes it: `⌘` or `Ctrl+`. */
export const MOD = isMac ? '⌘' : 'Ctrl+'
