# Implementation Plan: Loot Detection Correctness

## Constitution Check

- **Surface Truthfulness**: masking covers every occurrence; a lost loot write
  appears in capture health instead of vanishing.
- **Explicit Failure**: `emit` returns false on a failed or paused write, and
  the value stays unrecorded so the next sighting retries it.
- **Architectural Restraint**: no new rule format, engine or UI. `group` is one
  optional field on the existing `lootPatterns` contract.
- **Risk-Based Test-First Verification**: every fault starts as a failing test;
  the empty-match test hung the RED run, which is the fault itself.

## Design

1. `findMatches` is pure: every match, value from the rule's declared group,
   zero-length matches skipped by advancing `lastIndex`.
2. `emit` filters by `type \0 target \0 sha256(value)`, writes, and only then
   marks the keys; failures go to `noteDbError('loot')`. Returns boolean.
3. `DETECT_AS_LOOT` gains `group`; the private-key shape (loot-only) matches
   the header plus its first key line, with the algorithm non-capturing.
4. `ingest.enrich` scans `session_output` stdout joined with a 4 KiB per-session
   tail (at most 64 sessions), cleared on `session_start`/`session_end`.
5. Loot rows are still written directly, not through `ingest()`; unifying the
   write doors is a separate, undecided change.
