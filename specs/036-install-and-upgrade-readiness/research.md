# Research: Install and Upgrade Readiness

- **Why all-of, not a second manifest shape**: `requires` stays any-of for
  alternatives (mitmproxy | mitmdump); `requiresAll` is additive and explicit.
- **Why a banner, not an issue**: the migration's outcome (backup path or
  failure) must appear where the operator clicked; the issue store carries a
  title only.
- **Why async login PATH**: measured 360–659 ms on the dev machine; blocking
  the window for it is not acceptable, so tool probes wait on a promise and
  caches are invalidated when PATH changes.
- **Checksums**: GitHub renames `RedLog Setup x.exe` to `RedLog.Setup.x.exe`
  on upload; the list uses served names so `sha256sum -c` finds the file.
- **Doc corrections**: 15 claims corrected, each against a code location (W2
  report) — including the hook recording output (it records metadata only) and
  pause only hiding events (it stops writes at the single write point).
