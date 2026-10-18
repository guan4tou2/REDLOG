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

## Slice 3 — setup flow (FR-004 as-is, FR-010, FR-014, US2.1)

Surveyed against the code on 2026-10-18. 059 already put external setup first,
kept the built-in terminal behind a toggle, ordered the first-run shell picker
by platform, and left advanced sources off by default. The operator then cut
this slice to what the spec actually requires and is not already done; three
pieces, one PR each:

**3a HUD has a switch, on by default (FR-014 as amended).** Today the HUD
opens on every project start and nothing stores a choice. Keep it on by
default; add `overlay.autoShow` (default true) to config and a switch on the HUD
settings page. `startProject` creates the overlay only when it is true. The
in-HUD toggle and the tray stay transient (they hide for the session); the
settings switch is the persisted choice. No behaviour change for anyone who
leaves it on. spec.md US1.1 and FR-014 were amended to match.

**3b Web card shows the current step (US2.1).** `HttpCaptureStep` opens the CA
block, its fingerprint and the trust/untrust commands from the start
(`showCa` defaults true). Default it closed, put fingerprint and manual
commands in a nested disclosure, give the toggle a testid. Check the
`first-run-http-ca*` assertions in first-run-record-terminal and
managed-http-capture before flipping the default.

**3c Platform-ordered settings (FR-010, US4.1).** `HooksPanel` lists every hook
in registry order, so PowerShell and WSL sit on macOS as dimmed rows, and the
windowsOutput pack renders everywhere. Sort by platform relevance and move
non-native shells and the Windows pack into a collapsed "other platforms" group.
Risk: first-run.spec.ts:198 takes `install` `.first()`; the host shell must
keep that position.

**3d / 3e dropped.** A command-palette entry for setup (FR-004) and a
collapsed first-screen web card (FR-001) were proposed and cut: the Dashboard
card already re-opens setup, 059 already made the first screen external-first,
and neither is required by the spec. One test is kept: advanced sources default
to off (US4.2), as a plain regression guard.

Verification: Vitest per slice, the five gates, and the affected Electron
journey. Windows/WSL stays deferred (暫緩).
