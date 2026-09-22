# Implementation Plan: Shared Event Filter

## Technical Context

- Electron renderer communicates through typed preload IPC to SQLite queries.
- Search uses FTS5 with deterministic two-tier cursors.
- Transcript and HTTP History project bounded event sets in the renderer.
- Scope identity is defined by `src/core/scope-evaluator.ts`.

## Constitution Check

- Canonical Domain Semantics: one `EventFilter` shape crosses every layer.
- Query Completeness: predicates are included in SQL before `LIMIT` and cursor.
- Surface Truthfulness: capped unfiltered datasets are not presented as filtered.
- Architectural Restraint: reuse current query and projection paths.
- Risk-Based Verification: add pagination counterexamples before implementation.

## Design

1. Add a canonical `EventFilter` and scope policy snapshot to the DB query layer.
2. Resolve the active project scope in main IPC; renderers send only operator
   choices, not authoritative scope rules.
3. Compose the same SQL predicates into regular and FTS queries for both tiers.
4. Make Search, Transcript and HTTP History pass shared filters before limits.
5. Keep content search, method/status and transcript-kind filters local until
   their projection-specific query features are implemented.

## Gate

Target/scope counterexamples, typecheck, full tests, build and affected renderer
tests must pass before this feature becomes Verified.
