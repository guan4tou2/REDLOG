# Feature Specification: HTTP Flow Query

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Browse complete HTTP flows (Priority: P1)

As an operator, I need request and response records to remain together when
HTTP History is paged so a response is never hidden by an event-row limit.

### User Story 2 - Know whether older flows exist (Priority: P1)

HTTP History must distinguish a complete loaded set from a recent subset and
let the operator continue from an opaque cursor.

### User Story 3 - Preserve evidence on failure (Priority: P2)

A failed next-page request must retain loaded flows, cursor and retry context.

## Requirements

- **FR-001**: Pagination MUST select complete `flow_id` units before fetching rows.
- **FR-002**: Shared target, time and scope predicates MUST apply before the flow limit.
- **FR-003**: Request and response rows for a selected flow MUST return together.
- **FR-004**: HTTP History MUST expose complete, partial, loading and failed states.
- **FR-005**: Filter changes and live refresh MUST invalidate obsolete cursors.
- **FR-006**: Existing Activity, Every Request and Sitemap projections MUST consume the same loaded flow set.

## Success Criteria

- **SC-001**: Paging returns every qualifying flow exactly once with all captured halves.
- **SC-002**: No fixed event-row cap is used by HTTP History.
- **SC-003**: Existing HTTP activity behavior and desktop journeys pass.

## Assumptions

- Flow time is request time, falling back to the earliest captured row.
- Local text, method, status and host controls continue filtering loaded flows.
