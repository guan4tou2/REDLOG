# Verification: Terminal Resize Fidelity

**Status**: Verified
**Date**: 2026-09-22

## RED evidence

The real-PTY command-I/O journey resized its test session to 120x40 but found
only output frames in the resulting cast. The new geometry assertion failed
with an empty resize-frame list.

## Requirements trace

- Live sessions retain their current columns and rows.
- Positive integer geometry that differs from the current size resizes the PTY
  and appends `[elapsedSeconds, "r", "COLSxROWS"]` to the cast.
- Duplicate and invalid requests do not append frames.
- Output and resize frames share pause, availability, byte accounting and
  truncation rules. Cast failure does not prevent the PTY operation.
- Text slicing and cast FTS continue to consume only output frames, so resize
  geometry cannot appear as command output or a search hit.

## Test evidence

- Focused cast slicing, indexing and source-boundary suite: 33 tests passed.
- Full Vitest suite: 2,064 passed and 2 skipped across 178 files.
- TypeScript and production build passed.
- Electron command-I/O journey: 5 tests passed, covering a real resize frame,
  command byte-range integrity, chain contents and replay.
- `git diff --check` passed.

## Convergence

The spec, plan and tasks match the implementation. No required task remains.
Replay UI rendering of resize frames is intentionally outside this feature;
the `.cast` now contains the standard frame required by compatible players.
