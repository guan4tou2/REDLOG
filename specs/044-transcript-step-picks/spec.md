# Feature Specification: Transcript Step Picks

**Feature Branch**: `claude/review-issue-8gg2w7` (PR #232)
**Created**: 2026-09-30
**Status**: Verified
**Input**: #225. An operator writing up an engagement had no way to mark the
steps that mattered, or to copy one with enough context to cite it.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

## User Scenarios & Testing

### User Story 1 - Pick a step (Priority: P1)

**Independent Test**: Picking a step as a key step or a failed attempt records
a marker citing its events. "Picked only" narrows the transcript to picked
steps.

### User Story 2 - Copy with provenance (Priority: P1)

**Independent Test**: Copying one step gives Markdown naming its target, local
time with UTC offset and UTC, event IDs and session, in a fence its own
backticks cannot close, and saying whether the output is verbatim, a preview,
clipped in this copy or not captured.

## Requirements

- **FR-001**: A pick MUST be a marker that cites the step's events; the step
  itself MUST NOT be edited.
- **FR-002**: `marker:create` MUST accept `causes` and `targetId`, and create a
  plain marker unchanged when neither is given.
- **FR-003**: A copied step MUST state how complete its output is.
- **FR-004**: No assessment, scoring or report generation.

## Success Criteria

- **SC-001**: The marker IPC, the snippet builder and the pick UI each have a
  test that failed before the change.
