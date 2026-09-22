# Feature Specification: HTTP Body Search

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Find text stored in HTTP bodies (Priority: P1)

As an operator or incident responder, I can search for a token, error message or
response fragment even when RedLog externalized that body from the event row.

### User Story 2 - Trust filters and retention (Priority: P1)

Body matches obey the same target, source, time, scope, ordering and pagination
contract as ordinary event matches. Content removed by retention is no longer searchable.

## Requirements

- **FR-001**: Text body content externalized to sidecars MUST remain searchable.
- **FR-002**: A body hit MUST return its source event, not a detached search document.
- **FR-003**: Shared event filters and cursor bounds MUST apply before page limits.
- **FR-004**: Events matching both metadata and body MUST appear once.
- **FR-005**: The body index MUST be derived, project-local and excluded from evidence bundles.
- **FR-006**: Existing sidecars MUST be indexed without rewriting source events.
- **FR-007**: Missing or evicted sidecars MUST not leave searchable body content.
- **FR-008**: Binary/base64 bodies MAY be omitted from text search.

## Success Criteria

- **SC-001**: A marker present only after byte 4,096 of a body returns its HTTP event.
- **SC-002**: Body hits paginate with ordinary event hits without duplicates.
- **SC-003**: Deleting the sidecar and pruning its index removes the hit.

## Assumptions

- Search returns the event carrying the body reference; the existing HTTP detail opens the content.
- The index is rebuildable from surviving event references and sidecars.
