# Implementation Plan: HTTP Body Search

## Constitution Check

- Evidence Integrity: source events and body files remain unchanged.
- Query Completeness: body IDs join the canonical event query before LIMIT.
- Explicit Failure: the existing search error path receives index failures.
- Architectural Restraint: use a project-local rebuildable FTS cache like cast search.

## Design

1. Maintain a separate `http-body-index.db` containing text plus source event IDs.
2. Link body references after canonical ingest succeeds.
3. Incrementally backfill older event references on search.
4. Combine matching event IDs with event FTS before canonical filters and pagination.
5. Prune indexed content when body retention deletes its sidecar.
