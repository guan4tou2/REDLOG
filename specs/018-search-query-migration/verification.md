# Verification: Search on the Shared Query Contract

## RED

- The migration corpus initially reported exactly five accepted meaning
  changes: event, agent session, session-scoped tool, transcript and upper-case
  condition input.
- Search UI tests initially failed because the panel called `searchPage`, did
  not show the parse, executed incomplete conditions, and did not disclose a
  bare tool ID's chosen agent session.
- The corpus also exposed that its first fixture confused RedLog Capture
  Session with Agent Session; the fixture and research decision were corrected
  before accepting new expectations.

## GREEN

- Focused query, corpus and Search UI suites: 75 tests passed.
- Full suite: 194 files passed; 2,215 tests passed and 2 skipped.
- TypeScript typecheck passed.
- Production Electron build passed.
- `git diff --check` passed.
- Desktop E2E: `e2e/search-query-contract.spec.ts` passed (1 test).

## Convergence Review

- Search and Transcript both parse with `parseQuery` and execute events through
  `runQuery` / `executeEventQuery` under the same shared filter.
- All four identifier conditions use the contract's exact field semantics;
  bare tool IDs report the selected Agent Session.
- Accepted meaning changes are recorded in `research.md` and pinned in the
  migration corpus. Existing free-text, punctuation, prefix matching, tier,
  filter and ordering behavior remains covered.
- Failure, partial cast failure, pagination failure and not-yet-indexed cast
  states remain distinct.
- Search shows how each token was interpreted and does not execute an
  incomplete condition.
- Spec 008 records that only its private query interpretation was superseded.

No unbuilt requirement remains in Spec 018.

## Follow-up: Spec 026

This migration covered Search and the Transcript. Two other entry points still
used the pre-contract `searchEvents` and were missed: the ⌘K command palette
and the local API's `/api/events/search`. Both also returned an empty result
on a failed search. Spec 026 moves them onto the contract.
