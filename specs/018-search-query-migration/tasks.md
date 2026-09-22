# Tasks: Search on the Shared Query Contract

## Phase 1 — Non-regression

- [x] T001 Capture a query corpus from the current Search: text, shared filter
      and selected event set.
- [x] T002 Add the corpus as a failing-on-difference test against the contract.
- [x] T003 Enumerate queries whose meaning the contract changes and record an
      explicit decision for each.

## Phase 2 — Migration

- [ ] T004 Replace Search's private query interpretation with the contract.
- [ ] T005 Support every contract condition in Search with the Transcript's
      resolution semantics, including tool-use session scoping.
- [ ] T006 Show which tokens Search read as conditions.
- [ ] T007 Preserve Search's failure, partial and not-yet-indexed states.

## Phase 3 — Verification

- [ ] T008 Verify cross-surface equivalence of query text and identifiers.
- [ ] T009 Run focused tests, typecheck, the full suite and build.
- [ ] T010 Run the Search desktop journey.
- [ ] T011 Record in Spec 008 that its private query handling is superseded.
- [ ] T012 Analyze and converge artifacts; record verification and mark Verified.
