# Feature Specification: Active Target Context

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Pin the host being worked (Priority: P1)

As an operator working across several hosts, I can set the current target once
and have otherwise unclassified commands, markers and screenshots attributed to it.

### User Story 2 - Trust target provenance (Priority: P1)

An explicitly observed target always wins over the current-target fallback,
and changing or clearing the current target leaves an attributable record.

## Requirements

- **FR-001**: Current target MUST be stored per project and restored when it reopens.
- **FR-002**: The app shell MUST always show whether a current target is set.
- **FR-003**: Operators MUST be able to set, replace or clear it without entering Settings.
- **FR-004**: Canonical ingest MUST apply it to shell, marker and screenshot events only when neither the producer nor enrichment found a target.
- **FR-005**: Marker and screenshot capture MUST use the same fallback semantics.
- **FR-006**: Target changes MUST append an event containing previous and next values.
- **FR-007**: A target list row MUST offer a direct “work on this target” action.
- **FR-008**: Project switches MUST NOT carry target context between projects.

## Success Criteria

- **SC-001**: Setting a target and recording an unclassified command, marker and screenshot gives all three the selected target.
- **SC-002**: A command naming another host is attributed to that host rather than the fallback.
- **SC-003**: Clearing the target makes later unclassified events targetless.

## Assumptions

- Current target controls attribution, while shared filters continue to control reading.
- This feature does not prevent recording or enforce scope.
