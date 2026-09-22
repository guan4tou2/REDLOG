# Implementation Plan: Event Causal Chain

## Constitution Check

- Evidence Integrity: traversal reads immutable rows only.
- Query Completeness: both tiers are traversed independently of UI pagination.
- Explicit Failure: unavailable references, truncation and query failures remain distinct.
- Canonical Domain Semantics: one backend query owns causal traversal.
- Architectural Restraint: extend the existing SQLite, IPC and Timeline seams.

## Design

1. Add a bounded breadth-first causal query over both event tables.
2. Return events, unique edges, unavailable cause IDs and truncation metadata.
3. Expose the query through the existing events IPC/preload contract.
4. Make Timeline focus load the canonical result and merge returned rows into its ordered store.
5. Show unavailable and truncated states in the existing focus/detail UI.
