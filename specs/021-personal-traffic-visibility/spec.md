# Feature Specification: Personal Traffic Visibility

**Feature Branch**: `feat/managed-http-capture`
**Created**: 2026-09-22
**Status**: Verified

Personal and local traffic must remain recorded for evidentiary honesty without
crowding the operator's default investigation view.

## Requirements

- **FR-001**: Timeline, Search, Transcript, HTTP History, and Loot MUST hide
  events targeting configured `personalDomains` by default.
- **FR-002**: Events without a target MUST remain visible.
- **FR-002a**: Terminal cast search results, which do not carry target metadata,
  MUST remain visible under the default personal-traffic filter.
- **FR-003**: The filter MUST run before pagination limits on bounded queries.
- **FR-004**: One visible shared-filter control MUST reveal the hidden rows.
- **FR-005**: This feature MUST NOT delete rows or alter export policy.

## Success Criteria

- A localhost burst cannot displace work events from a result page.
- The operator can reveal all locally retained rows with one click.

## Clarification

The filter only hides events with matching target metadata. Untargeted events
and terminal cast contents are not classified as private; UI must state this
limitation. Loot must expose the same visible reveal control.
