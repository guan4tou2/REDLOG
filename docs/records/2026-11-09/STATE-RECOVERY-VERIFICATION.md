# Capture and network recovery verification — 2026-11-09

The dashboard visual check exposed a contradictory HTTP row: a failed managed
proxy start displayed its error while historical requests made the status say
ready. Current failure and restart now outrank historical traffic; the operator's
explicit off state still outranks diagnosis. External proxy history retains the
existing behavior when there is no managed failure or restart.

- HTTP state unit matrix: 10 passed, including past traffic + failed, past
  traffic + starting, and a source error with a stale missing-install probe.
- Electron: 2 passed. One case checks failed → starting → running with the same
  saved-traffic snapshot; the other checks IP failure/recovery with Pivot
  nodes retained and CDP timeout → successful retry feedback.
- Typecheck, spec, architecture and i18n gates passed in order. Full local unit
  suite: 5918 passed, 41 skipped, 0 failed.
- Shell test fixtures now isolate the relay home and await the background
  sender's first call. Original payload/credential assertions are unchanged.

These are macOS Electron and native unit results. Native Windows profile/output
acceptance is recorded separately in the cast Reader PR, and WSL is not inferred.
