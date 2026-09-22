# Verification: Managed HTTP Capture

## RED

- Lifecycle tests failed because no managed proxy service existed.
- Terminal environment tests failed because built-in panes had no canonical
  managed proxy configuration.
- The browser action could report a proxied launch without establishing that a
  listener existed.

## GREEN

- Focused managed-proxy, terminal, browser and renderer suites: 36 tests passed.
- Full suite: 196 files passed; 2,228 tests passed and 2 skipped.
- TypeScript typecheck passed.
- Production Electron build passed.
- Desktop E2E `managed-http-capture.spec.ts` passed against a deterministic
  mitmdump process: automatic start reached running, UI stop reached stopped.
- `git diff --check` and the Spec Kit verified-spec gate passed.

## Convergence Review

- One main-process service owns only the `mitmdump` child it starts and retains
  actionable unavailable/failed diagnostics.
- Project open starts capture best-effort; project switch, close and app quit
  stop the owned child.
- Browser launch waits for readiness only when its configured proxy is the
  managed loopback endpoint. Custom/external proxy URLs remain operator-owned.
- New built-in terminal panes receive upper/lower-case HTTP(S) variables only
  from the current live managed state. Existing panes are not described as
  retroactively routed.
- REDLOG's own POSIX hook transports bypass the injected proxy explicitly, so
  local ingestion cannot loop through mitmproxy or disappear with capture.
- The shipped addon remains the sole HTTP event producer, preserving event
  schema, body sidecars, spool and provenance behavior.
- UI states and errors are available in English and Traditional Chinese.
- Project config owns the managed port; saving a changed port restarts the
  process, loopback browser launches use its live URL, and remote proxies remain
  external.
- Capture Health says process readiness and traffic freshness separately.
- Settings reports the HTTPS CA path/readiness without changing OS trust.
- A running child that exits transitions to failed, is written to the Timeline,
  and is no longer injected into newly created terminals.
- Transparent interception, bundled Python runtime and non-HTTP protocols stay
  outside this feature.

No unbuilt requirement remains in Spec 019.
