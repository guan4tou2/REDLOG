# Feature Specification: Install and Upgrade Readiness

**Feature Branch**: `feat/036-install-readiness`
**Created**: 2026-09-24
**Status**: Verified
**Input**: After installing RedLog, can it start reliably, and does it know whether capture can actually work on this machine? Installation and first-engagement setup are separate concerns; this spec is only the first.

## Problems (verified on main before this spec)

1. **The shell hook's dependencies were not declared.** `hooks/shell-common.sh`
   builds every event with `python3` and sends it with `curl`, but the
   starter-pack declared `shell-zsh` / `shell-bash` with `requires: []`, and
   `requires` meant any-of. Without python3 the UI said the hook was available
   and installed while nothing was recorded.
2. **Upgrades went silently dark.** Spec 006 retired the old hook files; rc
   files that still sourced them were never detected.
3. **PowerShell was manual-only** although the repo had install logic.
4. **A Dock/Finder-launched app could not find installed tools.** It inherits
   a minimal PATH, so `mitmdump` in `~/.local/bin` (uv) or Homebrew tools were
   reported missing and the managed proxy could not start.
5. **Releases had no checksums**, and the README's Quick Start began with
   `npm install` — a developer flow in the operator's first paragraph.

## Clarifications

### Session 2026-09-24

- Q: macOS signing / notarization? → A: Out of scope — no Apple Developer ID.
  The README documents the unsigned-build path (Open Anyway; `xattr` last).
- Q: Should the app remove its own quarantine? → A: No — Gatekeeper blocks the
  app before it can run; it is not an install mechanism.
- Q: Migrate old hooks with a shim? → A: No (Spec 006). Detect, back up, remove
  the old line, install the current adapter.
- Q: The spec gate forbids retired hook names in `src/`, but detection must
  name them. → A: One exact-path exemption for the detection list
  (`src/core/runtime-preflight.ts`), proven not to open the gate elsewhere.

## User Scenarios & Testing

### User Story 1 - Know on first launch what works (Priority: P1)

**Independent Test**: With python3 missing, the first-launch card names it,
gives the install command, says the built-in terminal still records, and still
lets the operator continue.

### User Story 2 - Upgrade without going dark (Priority: P1)

**Independent Test**: A `.zshrc` that sources a retired hook shows a banner;
one click backs up the file, removes the line, installs the current adapter and
tells the operator to open a new terminal.

### User Story 3 - Tools installed via uv/Homebrew are found (Priority: P1)

**Independent Test**: The login shell's PATH is merged at startup; preflight
waits for it; mitmdump in `~/.local/bin` is found.

### User Story 4 - Verify the download (Priority: P2)

**Independent Test**: The release carries `SHA256SUMS.txt` over the installers.

## Requirements

- **FR-001**: Hooks MUST declare all-of requirements (`requiresAll`); zsh/bash
  need python3 and curl, and are unavailable without them.
- **FR-002**: `runtime:preflight` MUST report each needed tool as found or
  missing with a copyable per-platform install command (mitmproxy via uv), the
  detected shell, and legacy hook references; it MUST run after the login PATH.
- **FR-003**: Legacy references in zsh/bash rc files and PowerShell profiles
  MUST be migratable in one action with a backup; no shim.
- **FR-004**: PowerShell MUST install in one action, idempotently.
- **FR-005**: First launch MUST show readiness without blocking entry.
- **FR-006**: On macOS/Linux the app MUST merge the login shell's PATH at
  startup without blocking the window or removing entries.
- **FR-007**: Releases MUST publish `SHA256SUMS.txt`; README and user guide
  MUST lead with the operator flow; stale doc claims MUST be corrected.

## Success Criteria

- **SC-001**: All new suites pass; the full suite passes; both gates pass.

## Assumptions

- macOS builds remain unsigned (no Developer ID).
- PowerShell install is verified with a platform override, not on Windows
  hardware; a redirected (OneDrive) Documents folder falls back to the manual
  line.
