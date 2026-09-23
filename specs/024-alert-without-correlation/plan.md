# Implementation Plan: Alerts Without Correlation

## Technical Context

- `alert/policies.ts`: IPPolicy, ScopePolicy (kept); CombinedPolicy, BurstPolicy
  (removed).
- `alert/policy.ts`: `Verdict` union includes `combined` and `burst`.
- `alert/bus.ts`: `DerivedPolicy`, `isDerived`, a second `derived` list, and a
  depth-capped recursive `emit`.
- `alert/surface.ts`: ChainEmitter formats `combined_alert` and `burst_alert`.
- `main/services/alert-runtime.ts`: constructs and registers both.
- Tests: `test/alert/combined-burst.test.ts`; the derived-routing cases in
  `test/alert/bus.test.ts`.

## Constitution Check

- **Evidence Provenance**: removes derived chain events that cite no source.
- **Evidence Integrity**: stored events of the removed subtypes are untouched.
- **Architectural Restraint**: removes an abstraction layer with no present
  consumer beyond the chain.
- **Risk-Based Test-First Verification**: a failing test pins that no signal
  sequence can produce a combined or burst verdict; the existing alarm tests
  are the regression guard.

## Design

1. Add a failing test driving the signal sequences that used to trigger
   Combined and Burst, asserting no such verdict or event appears.
2. Remove the two policies, their configs and verdict types.
3. Collapse the bus to one policy list; `emit` fans out to surfaces only.
4. Remove the runtime wiring and the ChainEmitter formats.
5. Correct the stale comments.

## Gate

The new test, the unchanged alarm suites, typecheck, the full suite and build.
