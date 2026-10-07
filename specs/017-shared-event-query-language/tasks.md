# Tasks: Shared Event Query Language

## Phase 1 — Contracts

- [x] T001 Add failing parser tests: conditions, residual text, colon-bearing
      text such as URLs, unrecognised prefixes, conditions-only queries, a
      recognised prefix written as literal text, and field names in any case.
- [x] T001b Add tests that free text keeps whole-token matching and a
      prefix-matched final term.
- [x] T002 Add failing tests for exact event, session and transcript-UUID
      resolution, including a near match that must not be substituted.
- [x] T003 Add failing tests for session-scoped tool-use resolution, including
      the same tool-use ID present in two sessions.
- [x] T004 Add failing tests that a condition is not satisfied by its value
      appearing as text elsewhere in the record.
- [x] T005 Add failing tests for cross-page pair completion, for a bounded
      lookup count per page, and for a pair that stays unresolved.
- [x] T006 Add failing tests separating unparsable, failed and no-match, and
      covering the disclosure that text cannot reach non-inline command output.

## Phase 2 — Query contract

- [x] T007 Implement the parse: recognised conditions plus residual free text.
- [x] T008 Add expression indexes for the agent session ID and `tool_use_id`
      within `data`. The `session_id` column is not one of them.
- [x] T009 Implement intersecting evaluation — FTS for terms, field predicates
      for conditions — beneath the caller's shared filter, limit and cursor.
- [x] T010 Implement session scoping for a bare tool-use condition and report
      the resolved session.
- [x] T011 Return the parse with the results so surfaces can display it.
      Satisfied by the call shape rather than by a field: the caller parses and
      then executes, so it already holds the parse when it renders. The result
      carries only what the caller could not know — which session a bare
      tool-use condition resolved within.

## Phase 3 — Transcript

- [x] T012 Move the Transcript text box onto the contract per bucket, keeping
      balance, `hasMore` and cursor.
- [x] T013 Show which tokens were read as conditions, including the session a
      tool-use condition resolved within.
- [x] T014a Fetch absent counterparts for a page in one batched lookup.
- [x] T014b Mark pairs whose counterpart stays unresolved.
- [x] T015 Keep source and receipt time distinguishable through the projection.
      Carried the projection only; the two values stayed identical on every
      write path, so nothing downstream could tell them apart. Phase 5 finishes
      it.
- [x] T016 Restart cursors on query and filter change; restore the unqueried
      view when the query is cleared.
- [x] T017 Render unparsable, failed and no-match as three distinct recoverable
      states, plus the coverage disclosure; Spec 009 covers only load failure
      and empty.
- [x] T018 Make the completeness indicator describe the queried dataset, and
      label any filter still bound to loaded evidence.

## Phase 4 — Verification

- [x] T019 Run focused tests, typecheck, the full suite and build.
- [x] T020 Run the Transcript desktop journey.
- [x] T021 Update `docs/domain/glossary.md` with the query-language terms and
      with the capture-session / agent-session distinction.
- [x] T022 Record in Spec 009 that its local-text-filter exception is superseded.
- [x] T023 Analyze and converge artifacts; record verification and mark Verified.

## Phase 5 — FR-014 made real (2026-10-01)

T015 shipped the projection but not the distinction: `insertEvent` and
`insertLoggedEvent` both stamped `timestamp` and `created_at` from one
`Date.now()`, so Transcript's two labelled spans always printed the same
number and the covering test asserted only that two nodes existed. See the
amendment in `verification.md`.

- [x] T024 Add failing tests that a producer's occurrence time reaches
      `timestamp` while `created_at` stays the receipt clock, that an explicit
      `occurredAt` outranks `data.source_timestamp`, and that live capture
      leaves the two equal.
- [x] T025 Add a failing test that an unbelievable source time is refused,
      falls back to the receipt clock, and records the refusal inside the hash.
- [x] T026 Add a failing test that a backfilled run still verifies with no
      clock anomalies.
- [x] T027 Add failing Transcript tests that the two times are distinguishable
      when a replay pulls them apart, and that the second one is absent for an
      event captured live. The previous assertion could not fail.
- [x] T028 Implement `resolveOccurredAt` on both tiers: precedence, validation,
      `_source_time_rejected` folded in before hashing. The source time lands in
      `timestamp`, not `ts_source` — `timestamp` is the sort key, is inside the
      chain hash and is in the immutability trigger's column list, and
      `ts_source` is none of those. `ts_source` becomes provenance only.
- [x] T029 Point both clock-anomaly detectors at the receipt clock. Against
      `timestamp` they read a replayed transcript as a wall clock running
      backwards and fail verification on exactly the data this change
      represents. No-op for existing rows, where the two are equal.
- [x] T030 Thread `occurredAt` through `IngestInput` and `ingestEvent`.
      Producers already carrying `data.source_timestamp` — the tailer, at every
      one of its call sites — need no change.
- [x] T031 Transcript row: one time, `w-16`, no label, matching the Timeline
      event log; an amber lag badge only when the two differ by at least a
      second; a tooltip naming both whenever they differ at all, so Invariant #8
      holds per displayed result rather than per row-of-two-numbers.
- [x] T032 Timeline inspector: a `Recorded` row beside `Time`, on the same
      condition. It is a displayed result too, and its single time had become
      the occurrence time without saying so.
- [x] T033 Rename the receipt label away from 「收件」 — postal vocabulary for
      something that is not mail. 「寫入」 / `recorded`.
- [x] T034 Run typecheck, `verify:specs`, `verify:architecture` and the unit
      suite; record the amendment.
