# Verification: Architecture Gate — Every Export Reachable

## RED

- The gate on main (after #143) reported **55** findings: 24 unused exports and
  31 used only by tests.
- `test/raw-store.test.ts` › "writes into the project that is open now" failed:
  after `initDB(other)`, the second project's raw bytes were written under the
  first project's `raw/`.
- The PowerShell follower, Search's marker folding and the chain's full verify
  each had a test-covered function that production did not call (found by the
  gate as test-only).

## GREEN

- Gate: `Architecture gate passed: 234 source files, every export reachable
  from production (11 allowlisted)`. Each allowlist entry has a reason; 6 are
  product questions (plugin mappers never applied; raw store read path;
  `defaultShell`; the unbuilt dismiss UI).
- Raw store writes into the open project (test passes).
- `planTranscriptEmit` and `foldAllMarkers` are what production calls; chain
  tests (including the one #143 added for the anchored head) run on
  `verifyChainFullAsync`, the path the app uses; the sync variant and the
  superseded `buildCursorWhere` are gone.
- Full suite outside the sandbox: 211 files, 2266 tests pass. Typecheck and
  production build pass. CI runs `npm run verify:architecture` after the Spec
  Kit gates.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 5 answered (definition, seams, reference model, canonical rules scope, product questions) — in spec.md | 2026-09-23 |
| Checklist | `checklists/requirements.md`: 4 items, all pass | 2026-09-23 |
| Analyze | 1 finding fixed: research.md claimed a measured find-references cost that was never measured; reworded | 2026-09-23 |
| Converge | 1 finding fixed: a chain-anchor test #143 added still called the removed sync verify; ported to the async one | 2026-09-23 |
