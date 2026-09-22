# Implementation Plan: HTTP Flow Query

## Constitution Check

- Query Completeness: page flow units and expose `hasMore`.
- Surface Truthfulness: disclose partial and failed states.
- Canonical Domain Semantics: reuse shared EventFilter and scope resolution.
- Architectural Restraint: retain SQLite, IPC and current renderer projections.

## Design

1. Aggregate logged HTTP rows into flow heads ordered by request start.
2. Page heads with an opaque `(start time, flow id)` cursor.
3. Fetch every request/response row belonging to selected heads.
4. Expose the flow page through typed IPC.
5. Merge pages in HTTP History and render completeness and recovery state.
