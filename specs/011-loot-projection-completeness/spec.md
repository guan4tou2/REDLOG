# Feature Specification: Loot Projection Completeness

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Review every matching loot event (Priority: P1)

As an operator, I need the Loot view to disclose when it contains only recent
evidence and let me load older evidence without losing the current results.

### User Story 2 - Trust shared filters (Priority: P1)

Target, time, source and in-scope filters must select evidence before paging so
newer unrelated events cannot hide older matching loot.

### User Story 3 - Recover from read failures (Priority: P2)

An initial read failure must not look like an empty haul. A failed older-page
read must preserve loaded evidence and remain retryable.

## Requirements

- **FR-001**: Loot MUST use a bounded, cursor-based evidence query.
- **FR-002**: Shared filters MUST apply before the page limit.
- **FR-003**: The view MUST distinguish complete and recent-subset datasets.
- **FR-004**: Loading another page MUST merge every event exactly once.
- **FR-005**: Initial and next-page failures MUST be explicit and retryable.
- **FR-006**: A failed next-page read MUST retain loaded evidence and cursor.
- **FR-007**: Filter changes and live loot updates MUST invalidate obsolete cursors.
- **FR-008**: Local loot-type and dedup controls MAY operate over the loaded set,
  provided dataset completeness remains visible.

## Success Criteria

- **SC-001**: More than one page of qualifying loot can be traversed without
  omissions or duplicate event IDs.
- **SC-002**: A failed read never produces an empty-state claim.
- **SC-003**: Operators can tell whether older qualifying evidence remains.
- **SC-004**: Existing loot filtering, deduplication and timeline navigation continue to work.

## Assumptions

- The existing shared event filter defines target, time and scope semantics.
- Local type chips and deduplication describe only the currently loaded dataset.
