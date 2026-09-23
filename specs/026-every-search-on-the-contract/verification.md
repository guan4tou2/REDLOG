# Verification: Every Search on the Query Contract

**Status**: Verified
**Date**: 2026-09-23

## RED

- Palette (`test/command-palette.test.tsx`): four tests failed for the intended
  reasons — the palette called `events.search` rather than `runQuery`, sent
  `session:S1` as text, showed "no matches" for a rejected query, and ran a
  half-typed condition. The existing debounce test was updated from asserting
  the retired call to asserting the contract call.
- API (`test/api-server.test.ts`): `session:API-S1` returned `[]` — not even
  the owning event — and `session:` returned 200 instead of 400.

A fake-timer leak in the palette suite was fixed along the way: a test failing
between `useFakeTimers()` and `useRealTimers()` left fake timers installed and
turned five unrelated tests into 15-second timeouts. `afterEach` now restores
real timers.

## GREEN

- The palette parses, then calls `runQuery`, and renders failed and
  unparsable states instead of "no matches".
- The API parses, returns 400 with `reason` and `token` for an unparsable
  query, calls `executeEventQuery`, and returns 500 on failure.
- `events:search` is removed; the palette was its only caller.
- `searchEventsPage` is removed. `search-pagination.test.ts` and
  `http-body-search.test.ts` run their original assertions unchanged through a
  local helper over the contract.
- `executeEventQuery` returns an empty page for a query with neither text nor
  conditions.
- Spec 018's verification records the two entry points it missed.

## Evidence

- Search, contract, corpus, palette and scope-guard suites: 110 pass.
- Full suite: 194 files pass in the sandbox; the three sandbox-bound suites
  (`api-server`, `external-session`, `shell-redlog-run`) pass outside it, 23/23.
- Typecheck and production build pass.

## Process note

A scripted edit removing the `events:search` handler also removed the adjacent
`events:runQuery` handler: its lookahead skipped the comment block above
`runQuery`. The diff was checked before committing and the handler restored;
`shared-event-filter.test.ts`, which asserts the scope wiring of that handler,
would also have failed.
