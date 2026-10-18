# Tasks

## Slice 1
- [x] T001 Test: a regular-proxy request does not make the transparent producer ready; stamped transparent events do; unstamped rows count as regular.
- [x] T002 Addon stamps `proxy_mode`; transparent launcher sets `REDLOG_PROXY_MODE`; capture health filters by it.
- [x] T003 Test: a zsh command is not proof for a Bash-only install.
- [x] T004 Restrict own-terminal evidence to installed shells.
- [x] T005 Test: empty web scope never reads "out-of-scope masked" in the export preview.
- [x] T006 Preview policy line and out-of-scope row follow the scope snapshot; en and zh-TW strings.
- [x] T007 Typecheck, spec, architecture and i18n gates, full unit suite.
- [x] T008 Electron journey: e2e/export-preview and filtered-export pass (5 tests). Capture health has no e2e of its own; covered by unit tests.

## Slice 2
- [x] T010 Terminal row: waiting / command received / output received, with time (FR-003). `ownShellOutputAt` comes from own-shell `command_end` with `output_disposition: captured`; the source is the installed shell filter from slice 1.

## Slice 3 (plan: see plan.md; one PR per item)
- [ ] T020 3a HUD `overlay.autoShow` default false, hidden creation, settings toggle, hud-overlay e2e, CHANGELOG (FR-014).
- [ ] T021 3b Web card: CA block closed by default, nested fingerprint/commands disclosure, toggle testid (US2.1).
- [ ] T022 3c Settings: platform-ordered hooks, "other platforms" group, Windows pack collapsed off Windows (FR-010).
- [ ] T023 3d Re-entry: palette entry and Settings link to the same setup panel (FR-004).
- [ ] T024 3e First screen: web card collapsed, "all sources" filtered to core, test pinning advanced-source defaults (FR-001, US4.2).
