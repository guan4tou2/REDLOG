# Verification: Shared Event Query Language

## RED

- Parser and resolver tests first failed because no shared query contract or
  identifier predicates existed.
- Transcript integration tests first failed because its text box filtered only
  loaded blocks, missing tool counterparts were never fetched, unresolved
  halves looked pending, source and receipt time were collapsed, and the
  completeness label did not describe the queried dataset.

## GREEN

- Focused Transcript query and integrity suites: 23 tests passed.
- Full suite: 194 files passed; 2,212 tests passed and 2 skipped.
- TypeScript typecheck passed.
- Production Electron build passed.
- `git diff --check` passed.
- Desktop E2E: `e2e/transcript-view.spec.ts` passed (1 test).

## Convergence Review

- Conditions and residual text use one parser and intersect at the persistence
  layer across both event tiers.
- Event, agent-session, transcript and session-scoped tool identifiers resolve
  exactly; the capture-session column is not substituted for agent session.
- Transcript retains per-bucket cursors and balance, performs one batched
  counterpart lookup per loaded page, and labels unresolved halves.
- Query parse, store failure, no-match, query coverage, completeness, local
  kind filtering, source time and receipt time are visible and distinct.
- Spec 009 records the superseded local-text behavior and the domain glossary
  defines Event Query, both session identities and both time meanings.

No unbuilt requirement remains in Spec 017. Search adoption remains bounded to
Spec 018.
