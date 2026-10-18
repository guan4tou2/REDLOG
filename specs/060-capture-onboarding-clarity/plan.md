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

Re-entry point, platform-ordered setup, HUD not auto-opened. Needs its own plan
review before work starts.

Verification: Vitest per slice, the five gates, and the affected Electron
journey. Windows/WSL stays deferred (暫緩).
