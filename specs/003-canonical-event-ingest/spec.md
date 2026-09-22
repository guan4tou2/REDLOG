# Feature Specification: Canonical In-Process Event Ingest

**Status**: Verified
**Created**: 2026-09-20

## User Story

As an operator, I need equivalent activity to produce equivalent evidence
regardless of which built-in capture source observed it, so I can trust the
timeline, scope report, causal links, and later export.

### Acceptance Scenarios

1. **Given** recording is active, **when** any bounded in-process producer
   records an event, **then** the event is persisted and published exactly once
   through the canonical ingest policy.
2. **Given** recording is paused, **when** a non-exempt bounded producer emits
   activity, **then** neither its primary event nor derived companions are
   recorded or published.
3. **Given** a producer supplies explicit attribution, target, pause bypass, or
   envelope metadata, **when** it records an event, **then** those values reach
   the canonical ingest policy unchanged.
4. **Given** a producer event can be enriched, **when** it enters through an
   in-process source, **then** it receives the same causal, target, redaction,
   scope, companion, and provenance treatment as the equivalent API event.

## Goal

All capture producers that describe operator or target activity use `ingest()`
so source location does not change causal links, target extraction, redaction
spans, scope dispatch, companion generation, pause behavior, or publication.

## Requirements

- **FR-001**: Built-in terminal, transcript tailer, CDP, screenshot, connection,
  process and file-watcher primary events MUST enter through `ingest()`.
- **FR-002**: A producer MUST NOT call both `insertEvent()` and
  `eventBus.publish()` for a primary capture event.
- **FR-003**: Every migrated call MUST preserve engagement, operator, explicit
  target, bypass-pause and envelope metadata.
- **FR-004**: System lifecycle and maintenance events may continue using the DB
  primitive when they intentionally bypass capture enrichment; these exceptions
  must remain identifiable and are outside this bounded migration.
- **FR-005**: Existing observable event subtype and producer behavior MUST remain
  compatible while gaining canonical enrichment.

## Failure and Edge Cases

- A paused producer must not create a primary row, publish a notification, or
  derive companion rows unless its event type is explicitly pause-exempt or the
  caller carries an existing bypass policy.
- A duplicate rejected by persistence must not be published.
- A producer failure must continue to report through its existing capture
  health path rather than be represented as a successful event.
- Agent tool scope dispatch remains on its existing dedicated path until the
  canonical scope contract supports `agent.tool_call`; this migration must not
  silently remove that coverage or dispatch it twice.
- Producer payload field names and event subtypes remain compatible with
  existing timelines, status calculations, and export consumers.

## Success Criteria

- **SC-001**: All eight bounded source files pass an automated boundary check
  with zero direct `insertEvent()` or `eventBus.publish()` calls.
- **SC-002**: Targeted producer and ingest tests pass with no duplicate event or
  companion observations.
- **SC-003**: Typecheck and production build complete successfully.
- **SC-004**: The built-in terminal command I/O and connection-capture desktop
  journeys complete successfully against isolated project data.

## Domain References

- `.specify/memory/constitution.md`, especially Evidence Integrity, Canonical
  Domain Semantics, Explicit Failure, Evidence Provenance, and Risk-Based
  Test-First Verification.
- `docs/DESIGN-plugin-kernel.md` section 3 for the canonical ingest order.

## Out of Scope

External-shell stdout capture, built-in proxy lifecycle, derived maintenance
events, anchors, retention and export audit events.
