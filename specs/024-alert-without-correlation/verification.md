# Verification: Alerts Without Correlation

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/alert/no-correlation.test.ts` drives the runtime as the app wires it and
failed all three tests for the intended reasons:

- an exposed IP followed by an adjacent-scope hit produced
  `['ip', 'scope', 'combined']`;
- 25 adjacent-scope hits produced 25 `scope` verdicts and a `burst` verdict —
  which also confirmed Burst suppresses nothing: every scope verdict it
  counted still went through;
- the bus exported `DerivedPolicy` and the alert module exported
  `CombinedPolicy` and `BurstPolicy`.

## GREEN

- CombinedPolicy, BurstPolicy, their configs, their verdict types and their
  `combined_alert` / `burst_alert` chain formats are removed.
- The bus has one policy list; `emit` hands a verdict to every surface and
  nothing else, so the recursion guard is gone with the recursion.
- `alert-runtime.ts` no longer constructs or registers them.
- Stale comments corrected: the webhook surface (removed earlier) in the bus,
  signal and surface headers; the surface header's "four surfaces" that listed
  three; the policy header's description of both removed policies.
- `test/alert/combined-burst.test.ts` is removed; the two `bus.test.ts` cases
  that exercised derived routing and its recursion cap are replaced by one that
  asserts a verdict reaches surfaces only.

## Evidence

- Alert, scope and recompute suites: 120 tests pass. The IP, scope, badge,
  adherence and violation tests are unmodified.
- Typecheck and production build pass.
- Full suite: 2,233 passed; the only failures are the three sandbox-bound
  suites (`api-server`, `external-session`, `shell-redlog-run`), which need a
  local socket or a real shell and pass outside the sandbox.

## Notes

- `docs/ALERT-ROLES.md`, the alert design, never described Combined or Burst;
  they were added beyond it in v0.12.0. Nothing in it changes.
- Stored `combined_alert` and `burst_alert` events are untouched. No renderer
  code ever titled them specially, so their display does not change.
- `test/db/tier-classifier.test.ts` still asserts both subtypes classify as
  chained, which is correct for rows already stored.
