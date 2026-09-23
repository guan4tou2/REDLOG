# Verification: Loot Detection Correctness

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/loot-correctness.test.ts` against unchanged code:

- The empty-match test **hung the run** (the scan loop never advanced) and had
  to be stopped; it was then excluded to see the rest.
- 10 of the remaining 11 failed for the intended reasons: the private-key value
  was `RSA `; a repeated value was dropped from the scan (so the second
  occurrence had no redaction span); the plugin rule without `group` returned
  group 1; prefix-sharing tokens merged; the second target was not recorded;
  two private keys merged; PTY output produced no loot; a failed write could
  not be observed and was not retried.
- The eleventh — "does not join output across sessions or a session end" —
  passed only because PTY output was not scanned at all; it guards the wiring.

## GREEN

- `findMatches` is pure and returns every occurrence; values come from each
  rule's declared group; zero-length matches are skipped.
- `emit` dedups on type, target and sha256 of the full value, marks keys only
  after the write lands, reports failures as `loot` in capture health, and
  returns whether the row was written.
- The private-key shape includes the first key line; its algorithm group is
  non-capturing.
- PTY `session_output` is scanned with the previous chunk's 4 KiB tail.
- Two old loot-detector tests asserted scan-time dedup; they now assert the new
  contract, and a test that had become vacuous was removed. The golden corpus
  changes only in the private-key value.

## Evidence

- `loot-correctness`: 12 pass (including the empty-match test, which now
  terminates).
- Full suite outside the sandbox: 202 files, 2270 tests pass.
- Typecheck, production build and `verify:specs` pass.
