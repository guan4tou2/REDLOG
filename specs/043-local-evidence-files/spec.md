# Feature Specification: Local Evidence Files

**Feature Branch**: `claude/review-issue-8gg2w7` (PR #232, PR #235)
**Created**: 2026-09-30
**Status**: Verified
**Input**: #221. A loot file, tool report or pcap saved outside the watched
folders never reached the record.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

Domain contracts: `docs/domain/glossary.md` (Observed Artifact Correlation),
`docs/domain/SPEC-export-event-selection.md` (Evidence Bundle attachments).

## User Scenarios & Testing

### User Story 1 - Add a file the operator picks (Priority: P1)

**Independent Test**: "Add evidence file…" copies the picked file into the
project's `artifacts/`, hashes the copy and records `file_transfer` /
`artifact_added` with the hash, original path, size and mtime.

### User Story 2 - Drop files on the window (Priority: P2)

**Independent Test**: Dropping files asks for confirmation listing every file.
Declining copies nothing; confirming adds them. A drop no longer navigates the
window away.

### User Story 3 - Carry it in the bundle (Priority: P1)

**Independent Test**: A bundle with the adding event carries the file and
lists it in the preview; it can be left out (Spec 040); scope masking drops it
when its target is out of scope.

### Edge Cases

- Too large (over 200 MB), disk full, unreadable, not a file and duplicate are
  each reported, not silently skipped.
- A shell command that ran in the file's folder while it was written is listed
  as a possible relationship, never as a cause.
- Anything that is not an absolute path is ignored without asking.

## Requirements

- **FR-001**: RedLog MUST read only the files the operator picked or dropped.
- **FR-002**: The copy MUST be hashed and the event MUST carry hash, original
  path, size and mtime.
- **FR-003**: Each failure outcome MUST be reported per file.
- **FR-004**: A dropped file MUST be added only after a confirmation that
  lists it.
- **FR-005**: The bundle MUST carry an artifact only with an exported event
  that added it.

## Success Criteria

- **SC-001**: Adding, every failure outcome, the drop confirmation and the
  bundle round trip each have a test that failed before the change.
