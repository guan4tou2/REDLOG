# Plan

Delivered in slices, in the order manual-acceptance.md recommends. Existing
adapters, installer and ExportPlan contracts are kept (059, 049, 052, 056).

## Slice 1 — source truthfulness (FR-003 partial, FR-009, FR-011)

1. The mitmproxy addon stamps `proxy_mode` (`regular` | `transparent`) on HTTP
   events, from `REDLOG_PROXY_MODE`, which only the transparent-proxy launcher
   sets. Capture health reads it: the regular row ignores transparent events,
   the transparent producer counts only its own. Events from before the stamp
   count as regular.
2. The terminal row's "own terminal included" evidence is limited to shells
   whose adapter is installed (`data.shell`); rows without the field still count.
3. The export preview says "no web scope set, nothing masked" when the plan's
   scope snapshot is empty, and hides the "out of scope (masked)" count.

## Slice 2 — output vs command evidence (FR-003 rest, FR-007)

Terminal row distinguishes waiting / command received / output received with
verification time and source; no event-schema change.

## Slice 3 — setup flow (FR-001/002/004/005/010/014)

Surveyed against the code on 2026-10-18. 059 already put external setup first,
kept the built-in terminal behind a toggle, and ordered the first-run shell
picker by platform; this slice closes what is left. Five independent pieces,
one PR each, in this order (risk and value, not size):

**3a HUD does not open on its own (FR-014).** `createOverlayWindow`
(main/windows.ts) shows at once and `startProject` calls it on every project
open, so a new project gets a HUD nobody asked for. No setting stores the
choice. Add `overlay.autoShow` (default false), create the window hidden, show
it from `startProject` only when set, and add a toggle on the HUD settings page.
The existing toggle and tray keep working. Touches e2e/hud-overlay.spec.ts
(assumes a visible overlay: toggle first). CHANGELOG note: a saved HUD position
no longer implies it opens.

**3b Web card shows the current step (US2.1).** `HttpCaptureStep` opens the CA
block, its fingerprint and the trust/untrust commands from the start
(`showCa` defaults true). Default it to closed, put fingerprint and manual
commands in a nested disclosure, and give the toggle a testid. Check
`first-run-http-ca*` assertions in first-run-record-terminal and
managed-http-capture before flipping the default.

**3c Platform-ordered settings (FR-010, US4.1).** `HooksPanel` lists every hook
in registry order, so PowerShell and WSL sit on macOS as dimmed rows, and the
windowsOutput pack renders everywhere. Sort by platform relevance, move
non-native shells and the Windows pack into a collapsed "other platforms" group.
Risk: first-run.spec.ts:198 takes `install` `.first()`; the order it depends on
must stay stable for the host shell.

**3d Re-entry (FR-004, US1.5).** The only way back is the Dashboard card's
setup button (`setupOpen` is local state in DashboardView). Add a command-palette
entry and a Settings link that open the same panel, which means lifting that
state to App. Nothing about setup progress is stored and none needs to be:
first-run is derived from evidence, so a restart re-derives it. Persisting the
selected shell is optional and left out unless 3d review asks for it.

**3e First screen is one choice at a time (FR-001, FR-010, US4.2).** Keep the
Commands card primary and collapse the web card to its header until opened.
Filter the first-run "all sources" disclosure to the two core sources. Advanced
sources already default off (config packs, clipboard preview); add a test that
pins that. Risk: e2e asserts the testids first-run-strip, -commands-status,
-http-status and the text "○ Not verified".

Open questions (need an answer before 3a and 3e):
1. Existing projects with a HUD position: default `autoShow` false for everyone,
   or true for projects that already have a saved position?
2. The web card auto-starts the managed proxy today. When collapsed, should it
   still start, or start only when opened?

Verification: Vitest per slice, the five gates, and the affected Electron
journey. Windows/WSL stays deferred (暫緩).
