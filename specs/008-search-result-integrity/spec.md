# Feature Specification: Search Result Integrity

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified
**Input**: Keep empty, failed, partial and retrying search states distinct without losing the operator's query or filters.

## User Scenarios & Testing

### User Story 1 - Recognize a failed search (Priority: P1)

As an operator, I need a failed event query to appear as a failure so I do not
conclude that evidence does not exist.

**Independent Test**: Reject the event query and verify Search shows an alert
with a retry action and never shows the no-results message.

### User Story 2 - Recognize partial results (Priority: P1)

As an operator, I need to know when event search succeeds but terminal-recording
search fails, because the visible results are incomplete.

**Independent Test**: Return event matches while rejecting terminal-recording
search and verify a partial-result warning remains visible with the matches.

### User Story 3 - Recover without rebuilding context (Priority: P2)

As an operator, I need retry to preserve my query and active filters, and a
failed Load More attempt to preserve already loaded results.

**Independent Test**: Fail once, retry successfully, and verify the same query
is issued; separately reject Load More and verify existing rows remain.

### Edge Cases

- A superseded or aborted request must not replace the current request state.
- Terminal-recording search is intentionally unavailable while shared event
  filters are active and must not be labeled as a failure.
- A new query clears errors from the prior query.

## Requirements

- **FR-001**: Search MUST render query failure separately from zero results.
- **FR-002**: Independent result sources MUST expose partial failure when one
  source succeeds and another fails.
- **FR-003**: Retry MUST preserve the current query and shared filters.
- **FR-004**: A failed next-page request MUST preserve loaded rows and cursor.
- **FR-005**: Stale or aborted requests MUST NOT overwrite current state.
- **FR-006**: Failure messages MUST provide a direct recovery action.

## Success Criteria

- **SC-001**: Automated tests cannot produce a no-results state from a rejected
  event query.
- **SC-002**: Partial-source failure remains visible beside successful results.
- **SC-003**: Retry succeeds without re-entering the query or filters.

## Assumptions

- This feature covers the Search surface. Transcript completeness remains Spec
  009, and global IPC observability can be added separately.
