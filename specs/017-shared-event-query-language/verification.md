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

## Amendment 2026-10-01 — FR-014 was nominal

The convergence note above ("source time and receipt time are visible and
distinct") described the DOM, not the data. Transcript rendered two labelled
spans, but every write path stamped `timestamp` and `created_at` from the same
`Date.now()`, so both spans always printed the same number and the covering test
asserted only that two nodes existed. A transcript replayed hours after the fact
— the tailer resumes from the sidecar's size, which is 0 for a session RedLog
has not seen — claimed to have happened at the moment of replay, and a
three-hour engagement collapsed onto one point of the Timeline.

### What now satisfies it

- `resolveOccurredAt` (`src/core/db/event-write.ts`) takes a producer's own
  occurrence time into `timestamp` and leaves `created_at` as RedLog's receipt
  clock, on both tiers. Precedence: explicit `occurredAt`, `envelope.tsSource`,
  `data.source_timestamp`.
- The source time lands in `timestamp` rather than the `ts_source` column
  deliberately: `timestamp` is the sort key for every query and for the keyset
  cursor, it is inside the chain hash, and it is in the immutability trigger's
  column list. `ts_source` is none of those, so a time displayed from it would
  sort against a different number and carry no tamper evidence. `ts_source` is
  now written as provenance only.
- A source time that cannot be believed (not finite, pre-2015, future) is
  refused, falls back to the receipt clock, and records the refusal in
  `_source_time_rejected`, folded in before hashing.
- Both clock-anomaly detectors now compare the receipt clock. Pointed at
  `timestamp`, they would have flagged every backfilled row as a wall clock
  running backwards — `verifyChainFullAsync` would have failed on exactly the
  data this change exists to represent.
- Invariant #8 is met per displayed result rather than per row-of-two-numbers:
  the row carries the occurrence time, and the receipt time appears beside it —
  amber lag badge in Transcript, a `Recorded` row in the Timeline inspector —
  whenever the two actually differ. The tooltip names both whenever they differ
  at all, including below the badge's one-second floor. Printing both
  unconditionally cost ~150px of a header whose only flexible element is the
  actor name, to say the same thing twice.

### Evidence

- `test/ingest.test.ts` → "source occurrence time" (5 tests): source time
  reaches `timestamp`, receipt stays independent, explicit outranks `data`,
  live capture leaves them equal, an unbelievable time is refused inside the
  hash, and a backfilled run still verifies with no clock anomalies.
- `test/transcript-query-integrity.test.tsx`: the two times are asserted to
  differ when a replay pulls them apart, and the second is asserted absent for
  an event captured live. The previous assertion could not fail.
