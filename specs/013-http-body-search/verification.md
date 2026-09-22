# Verification: HTTP Body Search

**Status**: Verified
**Date**: 2026-09-22

## RED evidence

Three behavior tests failed because event FTS could only see the body reference:
an externalized-only marker returned no event, target-filtered body search
returned no event, and eviction could not be exercised because no initial hit existed.

## Requirements trace

- Text sidecars are indexed in project-local `http-body-index.db`; source events
  and sidecar bytes remain unchanged and the derived database is not exported.
- Canonical ingest links the source event after its evidence row lands.
- Search incrementally backfills references from both event tiers for existing projects.
- Matching event IDs join the ordinary FTS query before shared filters, cursor
  predicates and LIMIT. An event matching metadata and body remains one row.
- Age and size retention remove matching SHA rows from the derived index.
- Missing sidecars are omitted; an existing but unreadable sidecar fails the
  search and remains eligible for retry instead of advancing the backfill state.
- Base64 bodies are intentionally excluded from text indexing.

## Test evidence

- HTTP body search, pagination, body store and retention group: 51 tests passed.
- Final focused search, pagination and eviction run: 26 tests passed.
- Full Vitest suite: 2,068 passed and 2 skipped across 179 files.
- TypeScript and production build passed.
- Electron Search journey found a marker present only in an externalized body: 1 passed.
- `git diff --check` passed.

## Convergence

The spec, plan and tasks match the implementation. No required task remains.
The result is the source HTTP event; body parsing and finding extraction remain
outside RedLog's recording and retrieval boundary.
