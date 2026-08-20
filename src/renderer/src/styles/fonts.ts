// Bundled typefaces (docs/UIUX-STANDARD.md §2). The stack used to fall through
// to whatever the OS offered — -apple-system on macOS, Microsoft JhengHei UI on
// Windows — so the same screen had different metrics, different Han glyph
// shapes and a different apparent weight on every machine an operator ran it
// on. Shipping the files makes the three platforms agree.
//
// Only the subsets and weights the interface actually uses are imported.
// @fontsource splits the CJK face by unicode range, so the traditional-Chinese
// subset is ~1MB per weight rather than the ~17MB of the full face, and the
// four weights below are the ones §2's scale names (400 body, 500 label,
// 600 heading, 700 title).
import '@fontsource/noto-sans-tc/latin-400.css'
import '@fontsource/noto-sans-tc/latin-500.css'
import '@fontsource/noto-sans-tc/latin-600.css'
import '@fontsource/noto-sans-tc/latin-700.css'
import '@fontsource/noto-sans-tc/chinese-traditional-400.css'
import '@fontsource/noto-sans-tc/chinese-traditional-500.css'
import '@fontsource/noto-sans-tc/chinese-traditional-600.css'
import '@fontsource/noto-sans-tc/chinese-traditional-700.css'

// Mono carries IPs, hashes, exit codes, timestamps and event counts. Latin
// only — none of those are ever Han.
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'
