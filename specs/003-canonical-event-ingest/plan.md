# Implementation Plan

## Constitution Check

- **Evidence Integrity / Provenance**: preserve payloads, attribution, explicit
  targets, envelopes and existing failure reporting.
- **Canonical Domain Semantics**: `src/core/ingest.ts::ingest()` remains the one
  policy owner. A migration helper may preserve the DB primitive's call shape,
  but it must delegate directly to `ingest()` and must not recreate policy.
- **Explicit Failure**: producer catch paths continue to call capture-health.
- **Risk-Based Test-First Verification**: add a failing source-boundary guard
  before producer migration, then run unit, integration, build and affected
  desktop journeys.
- **Architectural Restraint**: retain Electron, React, SQLite and existing event
  payload contracts; add no framework or persistence layer.

## Domain Invariants

1. A primary event is persisted before it is published or used as the source of
   a derived event.
2. A successfully persisted primary event is published once.
3. A paused or deduplicated event is not published and produces no companions.
4. Existing producer metadata reaches `ingest()` without reinterpretation.
5. Agent tool scope coverage remains active until it can be moved into the
   canonical scope signal contract as a separately specified change.

## Affected Sources

- `src/core/ingest.ts`: migration-compatible adapter over `ingest()`.
- `src/main/terminal-manager.ts` and transcript services.
- CDP, screenshot, connection, process and file-watcher services.
- `test/canonical-ingest-sources.test.ts`: source-boundary regression guard.

## Phases

1. Inventory direct writes and classify primary capture versus maintenance.
2. Add a source guard test for the bounded producer set and record its expected
   failure before implementation.
3. Migrate one producer family at a time without changing payload schemas.
4. Run producer tests, ingest tests, typecheck, build and affected Electron
   command-I/O and connection-capture journeys.

## Deliberate Boundary

External shell stdout and built-in proxy defaults require separate product and
capture-source contracts. System anchors, retention and export audit writes are
maintenance paths and remain outside this migration.
