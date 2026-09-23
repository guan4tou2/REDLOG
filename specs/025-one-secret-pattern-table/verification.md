# Verification: One Secret Pattern Table

**Status**: Verified
**Date**: 2026-09-23

## Golden corpus

A 24-line corpus covering every shape both consumers knew, plus overlapping,
negative and flag lines, was run through the pre-refactor `redactSecrets` and
`LootDetector.findMatches`, and the outputs embedded in
`test/secret-patterns-golden.test.ts`.

- Before the refactor: redaction matched the capture (the test records current
  behaviour); the loot assertion and the flag assertion failed on the single
  flag line, the one intended change.
- After: redaction output is identical for all 24 lines; loot matches are
  identical in type, value, confidence and order for all 24, with the flag line
  now yielding no `flag` match.

## Structure

`test/secret-patterns-structure.test.ts` (7 tests): every shape has a sample
that matches it; no shape is unused; every redacted shape passes the transcript
prefilter; `compileShape` returns a fresh instance; neither consumer imports
anything but the table or contains an inline shape; no file carries the CTF
flag pattern.

## Evidence

- Golden, structure and loot/credential/secret suites pass.
- Typecheck and production build pass.
- Full suite: 196 files pass; the only failures are the three sandbox-bound
  suites (`api-server`, `external-session`, `shell-redlog-run`), which pass
  outside the sandbox.

## Notes

- The one shape whose literal was identical in both consumers,
  `aws_access_key`, is defined once; generation asserted the literals matched
  before merging.
- `LootPanel.tsx` keeps its colour for loot type `flag`, so stored flag loot
  still displays.
