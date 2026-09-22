# Verification: Loot Projection Completeness

**Status**: Verified
**Date**: 2026-09-22

## Requirements trace

- Loot now reads through the generic cursor-based event page contract with a
  fixed page boundary instead of the legacy capped array query.
- Target, time and in-scope predicates use the canonical shared EventFilter
  before the database limit. A non-loot source filter resolves honestly empty.
- The view labels complete and recent-subset datasets and provides Load Older.
- Page merges deduplicate by event ID; a failed older read keeps the loaded
  rows, cursor and retry action.
- Initial failure is distinct from an empty haul. Live-refresh failure keeps
  the last known evidence visible, while shared-filter changes clear stale rows.
- Existing loot-type chips, preview deduplication, render windowing and timeline
  navigation remain projection behavior over the loaded evidence.

## Test evidence

- Renderer tests cover partial-to-complete paging, explicit initial failure,
  older-page preservation/retry and a shared source filter that excludes loot.
- Database pagination walks seven loot rows over three pages exactly once while
  unrelated shell events do not consume the page limit.
- Final focused renderer, database and smoke run: 22 tests passed.
- Full Vitest suite: 2,062 passed and 2 skipped across 178 files.
- TypeScript and production build passed.
- Electron Loot journey seeded 205 events, observed Recent subset, loaded the
  older page and observed Complete loaded set: 1 test passed.
- `git diff --check` passed.

## Convergence

The spec, plan and tasks match the implementation. No required task remains.
Local loot-type and dedup controls intentionally operate over loaded evidence;
the completeness label makes that boundary explicit.
