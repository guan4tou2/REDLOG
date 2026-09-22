# Tasks: Shared Event Query Language

## Phase 1 — Contracts

- [ ] T001 Add failing parser tests: conditions, residual text, colon-bearing
      text such as URLs, unrecognised prefixes, conditions-only queries.
- [ ] T002 Add failing tests for exact event, session and tool-use resolution,
      including a near match that must not be substituted.
- [ ] T003 Add failing tests that the same query text selects the same events on
      both surfaces under one shared filter.
- [ ] T004 Add failing Search non-regression tests over queries valid today.
- [ ] T005 Add failing tests for cross-page pair completion and for a pair that
      stays unresolved.
- [ ] T006 Add failing tests separating unparsable, failed, no-match and
      not-yet-indexed.

## Phase 2 — Query contract

- [ ] T007 Implement the parse: recognised conditions plus residual free text.
- [ ] T008 Evaluate the contract at the persistence layer beneath the caller's
      shared filter, limit and cursor.
- [ ] T009 Return the parse with the results so surfaces can display it.

## Phase 3 — Surfaces

- [ ] T010 Move Search onto the contract with no change to its selected events.
- [ ] T011 Move the Transcript text box onto the contract per bucket, keeping
      balance, `hasMore` and cursor.
- [ ] T012 Show on both surfaces which tokens were read as conditions.
- [ ] T013 Complete absent tool counterparts by tool-use ID and mark pairs that
      stay unresolved.
- [ ] T014 Keep source and receipt time distinguishable through the projection.
- [ ] T015 Restart cursors on query and filter change; restore the unqueried
      view when the query is cleared.
- [ ] T016 Make the completeness indicator describe the queried dataset, and
      label any filter still bound to loaded evidence.

## Phase 4 — Verification

- [ ] T017 Run focused tests, typecheck, the full suite and build.
- [ ] T018 Run the Search and Transcript desktop journeys.
- [ ] T019 Update `docs/domain/glossary.md` with the query-language terms.
- [ ] T020 Record the supersession in Specs 008 and 009.
- [ ] T021 Analyze and converge artifacts; record verification and mark Verified.
