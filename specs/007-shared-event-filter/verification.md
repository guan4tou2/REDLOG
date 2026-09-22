# Verification: Shared Event Filter

**Status**: Verified
**Date**: 2026-09-22

## Requirements trace

- `EventFilter` carries target, event type, lower and upper time bounds, and
  the in-scope choice through renderer, preload, IPC, and SQLite.
- Main resolves the active project's canonical targets and exclusions before
  executing an in-scope query.
- Search applies predicates in both FTS tiers before its cursor and limit.
- Transcript applies predicates before each bounded event bucket.
- HTTP History applies predicates before its logged-event cap.
- Search restarts when a shared filter changes and reuses the same filter when
  loading the next cursor.
- Filtered Search suppresses `.cast` hits because that index has no target,
  event-type, or project wall-clock metadata and cannot truthfully satisfy the
  shared filter.

## Test evidence

- RED: three pagination counterexamples failed before implementation: scope
  before limit, target before pagination across tiers, and exclusion override
  with targetless evidence retained.
- Focused query and renderer suite: 73 tests passed.
- TypeScript: `npm run typecheck` passed.
- Full Vitest suite: 2,040 passed and 2 skipped across 170 files.
- Production build: `npm run build` passed.
- Electron Search journey: all 7 tests in `e2e/marker-amend.spec.ts` passed.
- `git diff --check` passed.

## Convergence

The spec, plan, and tasks agree on the implemented boundary. No required task
remains. Transcript still reads bounded per-type buckets and HTTP History still
projects a bounded logged-event set; relationship-aware projection pagination
belongs to later features. Search error-state integrity and complete transcript
projection remain separate Specs 008 and 009.
